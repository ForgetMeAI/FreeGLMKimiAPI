#!/bin/bash
# VNC startup script - starts Xvfb, fluxbox, x11vnc, and noVNC
set -e

# Create VNC password file
mkdir -p /root/.vnc
x11vnc -storepasswd "${VNC_PASSWORD}" /root/.vnc/passwd

# Start Xvfb (virtual display)
Xvfb ${DISPLAY} -screen 0 ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH} &
XVFB_PID=$!

# Wait for Xvfb to be ready
sleep 2

# Start fluxbox window manager
fluxbox &
FLUXBOX_PID=$!

# Start x11vnc (VNC server)
x11vnc -display ${DISPLAY} -forever -shared -rfbport ${VNC_PORT} -rfbauth /root/.vnc/passwd -noxdamage &
X11VNC_PID=$!

# Start noVNC (WebSocket proxy for web-based VNC)
websockify --web /opt/noVNC ${NOVNC_PORT} localhost:${VNC_PORT} &
WEBSOCKIFY_PID=$!

echo "[VNC] Started Xvfb (pid: ${XVFB_PID}), fluxbox (pid: ${FLUXBOX_PID}), x11vnc (pid: ${X11VNC_PID}), noVNC (pid: ${WEBSOCKIFY_PID})"
echo "[VNC] VNC: localhost:${VNC_PORT}, noVNC: http://localhost:${NOVNC_PORT}/vnc.html"
echo "[VNC] Password: ${VNC_PASSWORD}"

# Function to cleanup on exit
cleanup() {
    echo "[VNC] Shutting down..."
    kill ${WEBSOCKIFY_PID} ${X11VNC_PID} ${FLUXBOX_PID} ${XVFB_PID} 2>/dev/null || true
    wait ${WEBSOCKIFY_PID} ${X11VNC_PID} ${FLUXBOX_PID} ${XVFB_PID} 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# Keep script running
wait