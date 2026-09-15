#!/bin/bash
PORT=8765
PIDS=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill
  echo "已停止端口 $PORT 上的行知 Navi 服务。"
else
  echo "没有发现运行中的本地服务。"
fi
sleep 1
