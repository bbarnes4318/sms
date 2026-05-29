import urllib.request
import json
import time
import ssl
import urllib.error

ctx = ssl.create_default_context()
token = 'XL1gkrgHOVK8HfaVFU6r0aL3uyyzRWyejqLIVyNuCNnh6oEbYWuegOCCcziJRkCJ'
ssh_key_id = 113014717

def request(method, path, body=None):
    url = f'https://api.hetzner.cloud/v1/{path}'
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        },
        method=method
    )
    try:
        with urllib.request.urlopen(req, context=ctx) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8')
        print(f"HTTP Error {e.code}: {e.reason}")
        print("Response body:", err_body)
        raise e

def main():
    print("Initiating Hetzner VPS creation...")
    # Using cpx11 in ashburn (ash) as cx23 is Europe-only
    payload = {
        "name": "sms-gateway",
        "server_type": "cpx11",
        "image": "ubuntu-22.04",
        "location": "ash",
        "ssh_keys": [ssh_key_id],
        "start_after_create": True
    }
    
    try:
        response = request('POST', 'servers', payload)
        server = response['server']
        server_id = server['id']
        action = response['action']
        print(f"Server creation started. Server ID: {server_id}, Status: {server['status']}")
        print(f"Waiting for action (ID: {action['id']}) to complete...")
        
        while True:
            action_status = request('GET', f'actions/{action["id"]}')['action']
            print(f"Action status: {action_status['status']}")
            if action_status['status'] == 'success':
                break
            elif action_status['status'] == 'error':
                print("Error creating server:", action_status['error'])
                return
            time.sleep(3)
            
        print("Retrieving server details...")
        server_details = request('GET', f'servers/{server_id}')['server']
        ip = server_details['public_net']['ipv4']['ip']
        print(f"\n==================================================")
        print(f"SERVER CREATED SUCCESSFULLY!")
        print(f"Server Name: {server_details['name']}")
        print(f"Public IP:   {ip}")
        print(f"Location:    {server_details['datacenter']['location']['name']} ({server_details['datacenter']['location']['city']})")
        print(f"Server Type: {server_details['server_type']['name']}")
        print(f"To connect:  ssh -i <private_key_path> root@{ip}")
        print(f"==================================================\n")
        
        # Save IP to a local file for deployment scripts
        with open('scripts/server_ip.txt', 'w') as f:
            f.write(ip)
            
    except Exception as e:
        print("Failed to create server.")

if __name__ == '__main__':
    main()
