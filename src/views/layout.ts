// src/views/layout.ts
// HTML shell shared by the public dashboard and the admin UI.

import { html } from 'hono/html';

/**
 * Layout component - HTML shell with CDN links for Pico.css, HTMX, Alpine.js
 * @param title - Page title
 * @param content - Main content to render
 */
export const Layout = ({ title = 'Watch-Dog Sentinel', content }: { title?: string; content: ReturnType<typeof html> }) => html`
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <!-- Pico.css -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
  <!-- HTMX -->
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
  <!-- Alpine.js -->
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.0/dist/cdn.min.js"></script>
  <style>
    /* Custom dashboard styles */
    body {
      min-height: 100vh;
      background: #1a1a1a;
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
    }
    .project-card {
      border: 1px solid #333;
      border-radius: 0.5rem;
      padding: 1.25rem;
      background: #242424;
      transition: border-color 0.2s;
    }
    .project-card:hover {
      border-color: #444;
    }
    .project-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .project-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 0;
    }
    .maintenance-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem 0.5rem;
      background: #e67e22;
      color: #fff;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .check-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .check-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem;
      background: #2a2a2a;
      border-radius: 0.375rem;
      border-left: 3px solid;
    }
    .check-item.status-ok {
      border-left-color: #2ecc71;
    }
    .check-item.status-error {
      border-left-color: #e74c3c;
    }
    .check-item.status-dead {
      border-left-color: #7f8c8d;
    }
    .check-name {
      font-weight: 500;
      font-size: 0.9rem;
    }
    .check-meta {
      font-size: 0.75rem;
      color: #888;
      margin-top: 0.125rem;
    }
    .status-badge {
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.ok {
      background: rgba(46, 204, 113, 0.2);
      color: #2ecc71;
    }
    .status-badge.error {
      background: rgba(231, 76, 60, 0.2);
      color: #e74c3c;
    }
    .status-badge.dead {
      background: rgba(127, 140, 141, 0.2);
      color: #95a5a6;
    }
    .maintenance-controls {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid #333;
    }
    .maintenance-controls button {
      flex: 1;
      padding: 0.375rem 0.5rem;
      font-size: 0.75rem;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .last-updated {
      font-size: 0.75rem;
      color: #888;
    }
    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: #888;
    }
    .empty-state h3 {
      margin-bottom: 0.5rem;
      color: #aaa;
    }
    [x-cloak] {
      display: none !important;
    }
    .status-badge {
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.ok {
      background: rgba(46, 204, 113, 0.2);
      color: #2ecc71;
    }
    .status-badge.error {
      background: rgba(231, 76, 60, 0.2);
      color: #e74c3c;
    }
    .status-badge.dead {
      background: rgba(127, 140, 141, 0.2);
      color: #95a5a6;
    }
    /* Admin dashboard styles */
    .admin-dashboard .grid {
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
    .admin-dashboard article {
      border: 1px solid #333;
      border-radius: 0.5rem;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .admin-dashboard button.close-button {
      float: right;
    }
    .admin-dialog dialog {
      border: 1px solid #333;
      border-radius: 0.5rem;
      max-width: 500px;
      width: 90%;
    }
    .admin-dialog dialog[open] {
      display: flex;
    }

    /* Dialog mobile responsiveness */
    @media (max-width: 639px) {
      .admin-dialog dialog {
        max-width: 95vw;
        width: 95%;
      }

      /* Inline-styled modal from new-project endpoint */
      .modal-dialog {
        max-width: 95vw !important;
        width: 95% !important;
        padding: 1rem !important;
      }
    }
    .status-ok {
      color: #2ecc71;
    }
    .project-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin: 2rem 0;
    }
    .project-list article {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: #2a2a2a;
      border-radius: 0.375rem;
    }
    .project-list article header {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .project-list article details {
      font-size: 0.8rem;
    }
    .project-list article code {
      background: #333;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }

    /* ============================================================================
     * Responsive Design (RWD)
     * ============================================================================ */

    /* Mobile (< 640px) */
    @media (max-width: 639px) {
      /* Header: stack vertically */
      .main-header-row {
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 0.75rem !important;
      }

      .header-actions {
        align-self: flex-start;
      }

      /* Stats cards: single column */
      .stats-cards-grid {
        grid-template-columns: 1fr !important;
      }

      /* Dashboard grid: single column */
      .dashboard-grid {
        grid-template-columns: 1fr;
      }

      /* Project card: reduce padding */
      .project-card {
        padding: 1rem;
      }

      /* Maintenance controls: stack buttons */
      .maintenance-controls {
        flex-direction: column;
      }

      /* Project header: adjust font size */
      .project-title {
        font-size: 1rem;
      }
    }

    /* Tablet (640px - 1024px) */
    @media (min-width: 640px) and (max-width: 1024px) {
      /* Dashboard grid: 2 columns */
      .dashboard-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      /* Stats cards: 2-3 columns depending on space */
      .stats-cards-grid {
        grid-template-columns: repeat(3, 1fr) !important;
      }
    }

    /* Admin Dashboard - Mobile */
    @media (max-width: 639px) {
      /* Admin header: stack back button */
      .admin-header-row {
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 1rem !important;
      }

      /* Admin tabs: stack buttons vertically */
      .admin-tabs-nav {
        flex-direction: column !important;
      }

      .admin-tabs-nav button {
        width: 100%;
      }

      /* Settings form: single column */
      .admin-settings-grid {
        grid-template-columns: 1fr !important;
      }

      /* Projects tab header: stack New Project button */
      .admin-tab-header {
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 0.5rem !important;
      }

      .admin-tab-header button {
        width: 100%;
      }

      /* Projects table: smaller font */
      .admin-projects-table {
        font-size: 0.75rem;
      }

      /* Checks table inside card: smaller font */
      .checks-table {
        font-size: 0.7rem !important;
      }

      /* Checks list cards: remove outer card styling */
      .checks-list .project-card {
        padding: 0 !important;
        border: none !important;
        background: transparent !important;
      }

      /* Checks card wrapper */
      .checks-card-wrapper {
        background: #242424;
        border: 1px solid #333;
        border-radius: 0.5rem;
        margin-bottom: 1rem;
        overflow: hidden;
        width: 100%;
        box-sizing: border-box;
      }

      /* Checks expanded content - scrollable */
      .checks-expanded-content {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        max-width: 100%;
      }

      /* Checks table: remove horizontal padding on mobile */
      @media (max-width: 639px) {
        .checks-expanded-content {
          padding-left: 0 !important;
          padding-right: 0 !important;
        }

        .checks-table {
          font-size: 0.7rem !important;
        }

        .checks-table th,
        .checks-table td {
          padding: 0.5rem 0.25rem !important;
        }
      }
    }

      /* Checks table */
      .checks-table {
        min-width: max-content;
      }
    }

    /* Admin Dashboard - Tablet */
    @media (min-width: 640px) and (max-width: 1024px) {
      /* Settings form: 2 columns */
      .admin-settings-grid {
        grid-template-columns: repeat(2, 1fr) !important;
      }
    }

    /* Large screens (> 1400px) */
    @media (min-width: 1400px) {
      .container {
        max-width: 1400px;
        margin: 0 auto;
      }
    }
  </style>
</head>
<body>
  <main class="container">
    <header style="margin-bottom: 2rem;">
      <div class="main-header-row" style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h1 style="margin: 0; font-size: 1.75rem;">Watch-Dog Sentinel</h1>
          <p style="margin: 0.25rem 0 0 0; color: #888;">Passive Monitoring Dashboard</p>
        </div>
        <div class="header-actions">
          <span class="last-updated" x-data="{ updated: new Date() }" x-init="setInterval(() => updated = new Date(), 1000)">
            Last updated: <span x-text="updated.toLocaleTimeString()"></span>
          </span>
        </div>
      </div>
    </header>
    ${content}
  </main>
  <script>
    // Alpine.js time formatting utility
    document.addEventListener('alpine:init', function() {
      Alpine.magic('time', function() {
        return function(timestamp) {
          if (!timestamp) return 'Never';
          var date = new Date(timestamp * 1000);
          var now = new Date();
          var diff = Math.floor((now.getTime() - date.getTime()) / 1000);

          if (diff < 60) return 'Just now';
          if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
          if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
          return date.toLocaleDateString();
        };
      });
    });
  </script>
</body>
</html>
`;
