
import asyncio
import httpx
import sys
import os

import socket
import sys

def check(endpoint):
    print(f"Testing TCP connection to: {endpoint}")
    host = endpoint.split("://")[-1].split(":")[0]
    port = int(endpoint.split(":")[-1])
    print(f"Host: {host}, Port: {port}")
    
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5.0)
        print("Connecting...")
        s.connect((host, port))
        print("Connected!")
        s.sendall(b"GET /api/tags HTTP/1.0\r\nHost: "+host.encode()+b"\r\n\r\n")
        print("Request sent.")
        data = s.recv(1024)
        print("Received data:")
        print(data.decode("utf-8", errors="ignore"))
        s.close()
    except Exception as e:
        print(f"Socket Exception: {e}")

if __name__ == "__main__":
    url = "http://172.190.53.1:11434"
    if len(sys.argv) > 1:
        url = sys.argv[1]
    check(url)
