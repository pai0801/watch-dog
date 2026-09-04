"""
Watch-Dog Sentinel Python Client SDK

A fire-and-forget client for the Watch-Dog passive monitoring system.
Supports both heartbeat (periodic) and event (ad-hoc) monitoring scenarios.

Example Usage:
    # Heartbeat scenario (periodic health checks)
    from client_example import WatchDog

    wd = WatchDog(base_url="https://watchdog.example.com", project_token="your-token")
    wd.register([{
        "name": "db_health",
        "display_name": "Database Health Check",
        "type": "heartbeat",
        "interval": 60,
        "grace": 10,
        "threshold": 3
    }], project_id="my-service", display_name="My Service")

    # In your periodic check
    try:
        check_database()
        wd.pulse("db_health", status="ok", latency=45)
    except Exception as e:
        wd.pulse("db_health", status="error", message=str(e))

    # Event scenario (error tracking)
    wd.register([{
        "name": "payment_failure",
        "display_name": "Payment Processing Failures",
        "type": "event",
        "threshold": 1,
        "cooldown": 300
    }], project_id="my-service", display_name="My Service")

    try:
        process_payment()
    except Exception as e:
        wd.pulse("payment_failure", status="error", message=f"Payment failed: {e}")
"""

import logging
import threading
import time
from typing import List, Dict, Any, Literal, Optional

try:
    import requests
except ImportError:
    requests = None  # type: ignore


logger = logging.getLogger(__name__)

StatusType = Literal["ok", "error"]


class WatchDog:
    """
    Watch-Dog Sentinel Client for passive monitoring.

    This client sends heartbeats to the Watch-Dog Sentinel server.
    If heartbeats stop, the Sentinel will trigger an alert.

    All network operations are fire-and-forget: they run in background
    threads and never block or crash the main application.
    """

    def __init__(
        self,
        base_url: str,
        project_token: str,
        timeout: int = 5,
        silent: bool = True,
    ):
        """
        Initialize the Watch-Dog client.

        Args:
            base_url: The base URL of the Watch-Dog server
                      (e.g., "https://watchdog.example.com")
            project_token: The bearer token for authentication
            timeout: HTTP request timeout in seconds (default: 5)
            silent: If True, suppress all logging from this client (default: True)
        """
        self.base_url = base_url.rstrip("/")
        self.token = project_token
        self.timeout = timeout
        self.silent = silent
        self._headers = {
            "Authorization": f"Bearer {project_token}",
            "Content-Type": "application/json",
        }

    def register(
        self,
        checks: List[Dict[str, Any]],
        project_id: str,
        display_name: str,
    ) -> None:
        """
        Register or update check definitions.

        This is an idempotent upsert operation. Call it during application startup
        to ensure the Watch-Dog server has the latest check configurations.

        Args:
            checks: List of check definitions, each containing:
                - name (str): Unique check identifier (snake_case recommended)
                - display_name (str): Human-readable name for the dashboard
                - type (str): Either "heartbeat" (periodic) or "event" (ad-hoc)
                - interval (int, optional): Seconds between pulses for heartbeat type
                - grace (int, optional): Grace period in seconds before alert
                - threshold (int, optional): Consecutive failures before alert
                - cooldown (int, optional): Seconds to wait before re-alerting
            project_id: Unique project identifier (lowercase, numbers, hyphens).
                Required by the API — a payload without it is rejected with 400.
            display_name: Human-readable project name shown on the dashboard.

        Example:
            wd.register(
                [{
                    "name": "db_connectivity",
                    "display_name": "Database Connectivity",
                    "type": "heartbeat",
                    "interval": 60,
                    "grace": 10,
                    "threshold": 3
                }],
                project_id="my-service",
                display_name="My API Service",
            )
        """
        payload = {
            "project_id": project_id,
            "display_name": display_name,
            "checks": checks,
        }

        def _do_register():
            self._send_request("PUT", "/api/config", payload)

        threading.Thread(target=_do_register, daemon=True).start()

    def pulse(
        self,
        check_name: str,
        status: StatusType = "ok",
        message: str = "OK",
        latency: int = 0,
    ) -> None:
        """
        Send a heartbeat pulse for a check.

        This is a fire-and-forget operation. The pulse is sent in a background
        thread and any errors are silently swallowed to prevent impacting the
        main application.

        Args:
            check_name: The name of the check (must match registered name)
            status: Either "ok" or "error"
            message: Optional message describing the status
            latency: Latency in milliseconds (optional, for performance tracking)

        Example:
            wd.pulse("db_connectivity", status="ok", latency=42)
            wd.pulse("db_connectivity", status="error", message="Connection timeout")
        """
        payload = {
            "check_name": check_name,
            "status": status,
            "message": str(message),
            "latency": latency,
        }

        def _send_pulse():
            self._send_request("POST", "/api/pulse", payload)

        threading.Thread(target=_send_pulse, daemon=True).start()

    def _send_request(self, method: str, endpoint: str, payload: Dict[str, Any]) -> None:
        """Internal method to send HTTP requests in a background thread."""
        if requests is None:
            if not self.silent:
                logger.warning("Watch-Dog: requests library not installed, skipping request")
            return

        url = f"{self.base_url}{endpoint}"

        try:
            if method == "POST":
                requests.post(
                    url, json=payload, headers=self._headers, timeout=self.timeout
                )
            elif method == "PUT":
                requests.put(
                    url, json=payload, headers=self._headers, timeout=self.timeout
                )
        except Exception as e:
            # Silently fail - monitoring should never crash the main app
            if not self.silent:
                logger.warning(f"Watch-Dog request failed: {e}")


# =============================================================================
# DECORATOR SUPPORT
# =============================================================================

def watchdog_pulse(
    client: WatchDog,
    check_name: str,
    report_latency: bool = True,
):
    """
    Decorator that automatically sends pulses before and after function execution.

    The decorator sends an "ok" pulse after successful execution,
    or an "error" pulse if an exception is raised.

    Args:
        client: The WatchDog client instance
        check_name: The name of the check to pulse
        report_latency: If True, include execution time in milliseconds

    Example:
        @watchdog_pulse(wd, "cron_job_cleanup")
        def cleanup_old_records():
            # Your cleanup logic here
            pass
    """

    def decorator(func):
        def wrapper(*args, **kwargs):
            start_time = time.time() if report_latency else None
            try:
                result = func(*args, **kwargs)
                if start_time is not None:
                    latency = int((time.time() - start_time) * 1000)
                    client.pulse(check_name, status="ok", latency=latency)
                else:
                    client.pulse(check_name, status="ok")
                return result
            except Exception as e:
                client.pulse(check_name, status="error", message=str(e))
                raise

        return wrapper

    return decorator


# =============================================================================
# USAGE EXAMPLES
# =============================================================================

def example_heartbeat_monitoring():
    """
    Example 1: Heartbeat Monitoring (Periodic Health Checks)

    Use this for scheduled tasks that run periodically, such as:
    - Database connectivity checks
    - External API health checks
    - Cron job status monitoring
    """
    # Initialize client
    wd = WatchDog(
        base_url="https://watchdog.example.com",
        project_token="your-project-token-here"
    )

    # Register checks (do this at app startup)
    wd.register([
        {
            "name": "db_connectivity",
            "display_name": "Database Connectivity",
            "type": "heartbeat",
            "interval": 60,  # Expect a pulse every 60 seconds
            "grace": 10,     # Give 10 seconds grace period
            "threshold": 3,  # Alert after 3 consecutive failures
        },
        {
            "name": "external_api_health",
            "display_name": "External API Health",
            "type": "heartbeat",
            "interval": 30,
            "grace": 5,
            "threshold": 2,
        }
    ], project_id="my-service", display_name="My Service")

    # Simulate a health check function
    def run_db_health_check():
        start = time.time()

        try:
            # Your actual health check logic here
            # Example: db.execute("SELECT 1")
            time.sleep(0.05)  # Simulate some work

            latency = int((time.time() - start) * 1000)

            # Report success
            wd.pulse("db_connectivity", status="ok", latency=latency)
            print("Heartbeat sent: OK")

        except Exception as e:
            # Report failure
            wd.pulse("db_connectivity", status="error", message=str(e))
            print(f"Heartbeat sent: Error - {e}")

    # Run the health check
    run_db_health_check()


def example_event_monitoring():
    """
    Example 2: Event Monitoring (Ad-hoc Error Tracking)

    Use this to track specific error events, such as:
    - Payment processing failures
    - Critical application errors
    - Third-party service outages
    """
    wd = WatchDog(
        base_url="https://watchdog.example.com",
        project_token="your-project-token-here"
    )

    # Register event-type checks
    wd.register([
        {
            "name": "payment_failure",
            "display_name": "Payment Processing Failures",
            "type": "event",    # Event type (no regular pulses expected)
            "threshold": 1,     # Alert immediately on first failure
            "cooldown": 300,    # Wait 5 minutes before re-alerting
        },
        {
            "name": "critical_api_error",
            "display_name": "Critical API Errors",
            "type": "event",
            "threshold": 1,
            "cooldown": 60,
        }
    ], project_id="my-service", display_name="My Service")

    def process_payment(amount: float, currency: str = "USD"):
        """Example payment processing function."""
        try:
            # Your payment logic here
            print(f"Processing payment: {amount} {currency}")

            # Simulate a failure (comment out for normal operation)
            raise ConnectionError("Payment gateway timeout")

            # If successful, no pulse needed for event-type checks
            print("Payment successful")

        except Exception as e:
            # Only send pulse on error for event-type checks
            wd.pulse("payment_failure", status="error", message=f"Payment failed: {e}")
            raise

    # Run the payment processing (will trigger an alert in this example)
    try:
        process_payment(99.99, "USD")
    except Exception:
        print("Payment failed, alert sent to Watch-Dog")


def example_decorator_usage():
    """
    Example 3: Using the @watchdog_pulse Decorator

    The decorator automatically wraps your function with monitoring.
    """
    wd = WatchDog(
        base_url="https://watchdog.example.com",
        project_token="your-project-token-here"
    )

    # Register the check first
    wd.register([{
        "name": "cron_job_cleanup",
        "display_name": "Cleanup Old Records",
        "type": "heartbeat",
        "interval": 3600,  # Runs every hour
        "grace": 60,
    }], project_id="my-service", display_name="My Service")

    # Use the decorator
    @watchdog_pulse(wd, "cron_job_cleanup", report_latency=True)
    def cleanup_old_records():
        """Your cron job function."""
        time.sleep(0.1)  # Simulate work
        print("Cleanup complete")
        return 42  # Return value is passed through

    # Run the decorated function
    result = cleanup_old_records()
    print(f"Function returned: {result}")


# =============================================================================
# MAIN - Run examples when executed directly
# =============================================================================

if __name__ == "__main__":
    print("Watch-Dog Sentinel Python Client - Examples")
    print("=" * 50)
    print("\nNote: These examples use a placeholder URL and token.")
    print("Update them with your actual Watch-Dog server details.\n")

    # Uncomment to run examples:
    # example_heartbeat_monitoring()
    # example_event_monitoring()
    # example_decorator_usage()

    print("\nTo use in your application:")
    print("  from client_example import WatchDog")
    print("  wd = WatchDog(base_url='...', project_token='...')")
    print("  wd.register([...], project_id=..., display_name=...)")
    print("  wd.pulse('check_name', status='ok')")
