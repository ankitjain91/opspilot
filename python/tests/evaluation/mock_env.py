
import asyncio

class MockProcess:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0):
        self.stdout_data = stdout.encode('utf-8')
        self.stderr_data = stderr.encode('utf-8')
        self.returncode = returncode

    async def communicate(self):
        return self.stdout_data, self.stderr_data

    def kill(self):
        pass

    async def wait(self):
        return self.returncode

class MockK8sEnvironment:
    """Simulates a Kubernetes cluster state and responds to commands."""
    
    def __init__(self):
        self.scenarios = {} # Map command substring to (stdout, stderr, returncode)
        self.default_response = ("", "Error: resource not found", 1)
        self.command_log = []

    def set_scenario(self, command_pattern: str, stdout: str, stderr: str = "", returncode: int = 0):
        self.scenarios[command_pattern.lower()] = (stdout, stderr, returncode)

    def handle_command(self, command: str) -> MockProcess:
        self.command_log.append(command)
        cmd_lower = command.lower()
        
        # Find best matching scenario
        matched_result = None
        
        # Exact match first or contain match
        for pattern, result in self.scenarios.items():
            if pattern in cmd_lower:
                matched_result = result
                break
                
        if matched_result:
            return MockProcess(*matched_result)
            
        # Fallback for common things if not explicitly mocked
        if "get pods" in cmd_lower:
             return MockProcess("NAME                     READY   STATUS    RESTARTS   AGE\nsimple-pod               1/1     Running   0          5m", "", 0)
        
        return MockProcess(*self.default_response)
