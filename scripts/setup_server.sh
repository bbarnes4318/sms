#!/bin/bash
set -e

echo "=== System Update & Prerequisites ==="
apt-get update
apt-get install -y curl build-essential git python3 nginx ufw tar

# Install Node.js v20 (LTS)
if ! command -v node &> /dev/null; then
    echo "=== Installing Node.js v20 ==="
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed: $(node -v)"
fi

echo "=== Setting up App Directory ==="
mkdir -p /root/sms-app
tar -xzf /root/app.tar.gz -C /root/sms-app

echo "=== Installing Node Dependencies ==="
cd /root/sms-app
npm install --production

echo "=== Configuring Nginx ==="
cat << 'EOF' > /etc/nginx/sites-available/sms-gateway
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/sms-gateway /etc/nginx/sites-enabled/default
systemctl restart nginx

echo "=== Configuring Systemd Service ==="
cat << 'EOF' > /etc/systemd/system/sms-gateway.service
[Unit]
Description=Bulkvs SMS Gateway Application
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/sms-app
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
EOF

# Reload and enable service
systemctl daemon-reload
systemctl enable sms-gateway
systemctl restart sms-gateway

echo "=== Configuring Firewall (UFW) ==="
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "=== Deployment Completed Successfully ==="
systemctl status sms-gateway --no-pager | head -n 15
nginx -t
