import os
import tarfile
import subprocess
import sys

# Server configuration
SERVER_IP = '178.156.174.135'
SSH_KEY = 'scripts/id_ed25519'

def make_tarfile(output_filename, source_dir):
    print(f"Creating tarball of {source_dir}...")
    with tarfile.open(output_filename, "w:gz") as tar:
        for root, dirs, files in os.walk(source_dir):
            # Ignore node_modules, sqlite files, etc.
            if 'node_modules' in dirs:
                dirs.remove('node_modules')
            
            for file in files:
                # Skip local DB, config env files
                if file.endswith('.sqlite') or file.endswith('.sqlite-journal') or file.endswith('.sqlite-wal') or file == '.env':
                    continue
                
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, start=os.path.join(source_dir, '..'))
                tar.add(full_path, arcname=rel_path)
    print("Tarball created successfully.")

def run_command(cmd):
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, shell=True)
    if result.returncode != 0:
        print(f"Command failed with exit code: {result.returncode}")
        sys.exit(1)

def main():
    tarball = 'app.tar.gz'
    
    # 1. Create tarball
    make_tarfile(tarball, 'backend')
    
    # 2. Upload tarball
    print(f"Uploading {tarball} to {SERVER_IP}...")
    run_command([
        'scp', '-i', SSH_KEY, 
        '-o', 'StrictHostKeyChecking=no', 
        tarball, f'root@{SERVER_IP}:/root/app.tar.gz'
    ])
    
    # 3. Upload setup script
    print("Uploading setup_server.sh...")
    run_command([
        'scp', '-i', SSH_KEY, 
        '-o', 'StrictHostKeyChecking=no', 
        'scripts/setup_server.sh', f'root@{SERVER_IP}:/root/setup_server.sh'
    ])
    
    # 4. Run setup script on server
    print("Executing setup_server.sh on remote server...")
    run_command([
        'ssh', '-i', SSH_KEY, 
        '-o', 'StrictHostKeyChecking=no', 
        f'root@{SERVER_IP}', 'bash /root/setup_server.sh'
    ])
    
    # 5. Cleanup local tarball
    if os.path.exists(tarball):
        os.remove(tarball)
        print("Cleaned up local app.tar.gz.")
        
    print("\n==================================================")
    print("DEPLOYMENT DONE!")
    print(f"App UI available at: http://{SERVER_IP}")
    print(f"Webhook URL:         http://{SERVER_IP}/webhook/inbound")
    print("==================================================\n")

if __name__ == '__main__':
    main()
