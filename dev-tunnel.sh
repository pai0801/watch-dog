#!/usr/bin/env bash
#
# Dev Tunnel - 啟動本地開發服務 + ngrok tunnel
#
# Usage:
#   ./dev-tunnel.sh              # 默認 localhost
#   ./dev-tunnel.sh ngrok        # 使用 ngrok tunnel
#
# Port 分配：
#   8788 - flash-booking
#   8789 - watch-dog
#   8790 - din-next
#   8791 - order-landing
#   8792 - toppreview-edge
#   8793 - knowhub
#

set -e

# ==============================================================================
# 配置
# ==============================================================================

# 從 package.json 或 wrangler.jsonc 讀取專案名
PROJECT_NAME="${PROJECT_NAME:-$(basename "$(pwd)")}"
PORT="${DEV_PORT:-8788}"
MODE="${1:-localhost}"
WRANGLER_CMD="${WRANGLER_CMD:-npx wrangler dev}"

# 顏色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ==============================================================================
# 函數
# ==============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 檢查並停止佔用該 port 的進程
kill_port() {
    local port=$1
    local pid=$(lsof -ti :"$port" 2>/dev/null || true)

    if [ -n "$pid" ]; then
        log_warn "Port $port 已被 PID $pid 佔用，停止中..."
        kill "$pid" 2>/dev/null || true
        sleep 2

        # 如果還在，強制停止
        pid=$(lsof -ti :"$port" 2>/dev/null || true)
        if [ -n "$pid" ]; then
            log_warn "強制停止 PID $pid..."
            kill -9 "$pid" 2>/dev/null || true
            sleep 1
        fi
        log_success "Port $port 已釋放"
    else
        log_info "Port $port 可用"
    fi
}

# 啟動 wrangler dev
start_dev() {
    log_info "啟動 ${PROJECT_NAME} dev server (port $PORT)..."

    mkdir -p /tmp
    local log_file="/tmp/${PROJECT_NAME}-dev.log"

    # 啟動 wrangler dev
    $WRANGLER_CMD --local --ip 0.0.0.0 --port "$PORT" > "$log_file" 2>&1 &
    local dev_pid=$!

    # 等待啟動
    sleep 5

    # 檢查是否成功啟動
    if curl -s "http://127.0.0.1:$PORT/" > /dev/null 2>&1 || \
       curl -s "http://127.0.0.1:$PORT" > /dev/null 2>&1; then
        log_success "Dev server 已啟動 (PID: $dev_pid)"
        echo -e "  ${GREEN}Local:${NC}     http://127.0.0.1:$PORT/"
        echo -e "  ${GREEN}Network:${NC}   http://192.168.1.200:$PORT/"
    else
        log_error "Dev server 啟動失敗，查看日誌: tail -f $log_file"
        return 1
    fi

    echo "$dev_pid" > "/tmp/${PROJECT_NAME}-dev.pid"
}

# 啟動 ngrok tunnel
start_ngrok() {
    log_info "啟動 ngrok tunnel..."

    mkdir -p /tmp
    local log_file="/tmp/${PROJECT_NAME}-ngrok.log"

    npx ngrok http "$port" --log=stdout > "$log_file" 2>&1 &
    local ngrok_pid=$!

    # 等待 ngrok 啟動
    sleep 8

    # 提取 ngrok URL
    local url=$(grep -o "https://[^[:space:]]*\.ngrok[^[:space:]]*\.app" "$log_file" | head -1)

    if [ -n "$url" ]; then
        log_success "Ngrok tunnel 已啟動 (PID: $ngrok_pid)"
        echo -e "  ${GREEN}Public:${NC}    $url"
    else
        log_warn "無法獲取 ngrok URL，查看日誌: tail -f $log_file"
    fi

    echo "$ngrok_pid" > "/tmp/${PROJECT_NAME}-ngrok.pid"
}

# 顯示幫助
show_help() {
    cat << EOF
${GREEN}Dev Tunnel - 啟動本地開發服務 + ngrok tunnel${NC}

${YELLOW}Usage:${NC}
  ./dev-tunnel.sh [mode]

${YELLOW}Modes:${NC}
  (無參數)    localhost only
  ngrok        使用 ngrok tunnel
  stop         停止所有服務

${YELLOW}Environment Variables:${NC}
  PROJECT_NAME  專案名稱 (默認: 目錄名)
  DEV_PORT      端口號 (默認: 8788)

${YELLOW}Examples:${NC}
  ./dev-tunnel.sh           # localhost only
  ./dev-tunnel.sh ngrok     # with ngrok tunnel
  DEV_PORT=8790 ./dev-tunnel.sh  # custom port

${YELLOW}Port 分配:${NC}
  8788 - flash-booking
  8789 - watch-dog
  8790 - din-next
  8791 - order-landing
  8792 - toppreview-edge
  8793 - knowhub
EOF
}

# 停止所有服務
stop_services() {
    log_info "停止 ${PROJECT_NAME} 服務..."

    local dev_pid_file="/tmp/${PROJECT_NAME}-dev.pid"
    local ngrok_pid_file="/tmp/${PROJECT_NAME}-ngrok.pid"

    if [ -f "$dev_pid_file" ]; then
        local pid=$(cat "$dev_pid_file")
        if kill "$pid" 2>/dev/null; then
            log_success "已停止 dev server (PID: $pid)"
        fi
        rm -f "$dev_pid_file"
    fi

    if [ -f "$ngrok_pid_file" ]; then
        local pid=$(cat "$ngrok_pid_file")
        if kill "$pid" 2>/dev/null; then
            log_success "已停止 ngrok tunnel (PID: $pid)"
        fi
        rm -f "$ngrok_pid_file"
    fi

    # 清理 port
    kill_port "$PORT"
}

# ==============================================================================
# Main
# ==============================================================================

main() {
    # 處理 stop 命令
    if [ "$MODE" = "stop" ]; then
        stop_services
        return 0
    fi

    # 顯示幫助
    if [ "$MODE" = "help" ] || [ "$MODE" = "-h" ] || [ "$MODE" = "--help" ]; then
        show_help
        return 0
    fi

    # 開始
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  Dev Tunnel - ${PROJECT_NAME}${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""

    # 檢查必要的工具
    if ! command -v npx &> /dev/null; then
        log_error "npx 未安裝，請先安裝 Node.js"
        return 1
    fi

    # 清理 port
    kill_port "$PORT"

    # 啟動 dev server
    start_dev

    # 如果是 ngrok 模式
    if [ "$MODE" = "ngrok" ]; then
        start_ngrok
    fi

    echo ""
    log_success "所有服務已啟動！"
    echo ""
    echo -e "${YELLOW}查看日誌:${NC}"
    echo "  tail -f /tmp/${PROJECT_NAME}-dev.log"
    echo "  tail -f /tmp/${PROJECT_NAME}-ngrok.log"
    echo ""
    echo -e "${YELLOW}停止服務:${NC}"
    echo "  ./dev-tunnel.sh stop"
}

main "$@"
