#!/bin/bash
set -e

DOMAIN="sms.leadzer.io"
EMAIL="jimmy@getlifeassurance.com"

echo "=== Installing Certbot ==="
apt-get update
apt-get install -y certbot python3-certbot-nginx

echo "=== Requesting SSL Certificate for $DOMAIN ==="
# Request cert and configure Nginx automatically with redirects
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect

echo "=== Restarting Nginx ==="
systemctl restart nginx

echo "=== SSL Setup Completed for $DOMAIN! ==="
