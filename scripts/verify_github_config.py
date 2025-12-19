
import requests
import os
import json

CONFIG_PATH = os.path.expanduser("~/.opspilot/config.json")
API_URL = "http://127.0.0.1:8008/github-config"

def check_file():
    if not os.path.exists(CONFIG_PATH):
        print(f"❌ Config file NOT FOUND at {CONFIG_PATH}")
        return False
    
    try:
        with open(CONFIG_PATH, 'r') as f:
            data = json.load(f)
            pat = data.get('github_pat')
            print(f"📄 Config File ({CONFIG_PATH}):")
            if pat:
                print(f"   - github_pat: Found (len={len(pat)})")
            else:
                print(f"   - github_pat: MISSING/EMPTY")
    except Exception as e:
        print(f"❌ Failed to read config file: {e}")

def check_api():
    try:
        resp = requests.get(API_URL, timeout=2)
        if resp.status_code == 200:
            data = resp.json()
            print(f"🌐 API ({API_URL}):")
            print(f"   - configured: {data.get('configured')}")
        else:
            print(f"❌ API returned status {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"❌ Failed to connect to API: {e}")

if __name__ == "__main__":
    print("--- Verifying GitHub Configuration State ---")
    check_file()
    print("-" * 40)
    check_api()
