#!/bin/bash
# 行知 Navi — 在 Mac 本地启动
cd "$(dirname "$0")"
PORT=8765

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，直接打开已有服务。"
else
  echo "正在启动行知 Navi：http://127.0.0.1:$PORT/"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server "$PORT" >/tmp/xingzhi-navi.log 2>&1 &
  elif command -v python >/dev/null 2>&1; then
    python -m SimpleHTTPServer "$PORT" >/tmp/xingzhi-navi.log 2>&1 &
  else
    echo "未找到 Python。将直接用浏览器打开 index.html"
    open "index.html"
    exit 0
  fi
  sleep 0.6
fi

open "http://127.0.0.1:$PORT/"
echo "浏览器已打开。关闭本窗口不会停止服务；要停止请运行：关闭服务.command"
exit 0
