
import sys
import io
import contextlib
import traceback
from typing import Dict, Any, Optional
from kubernetes import client, config

# Global client cache to avoid reloading kubeconfig on every call
_CLIENT_CACHE = {}

def get_k8s_client(context_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Get or initialize Kubernetes clients for a specific context.
    Returns a dictionary of API clients (v1, apps_v1, custom, etc.)
    """
    global _CLIENT_CACHE
    
    # Use default context if none provided
    if not context_name:
        try:
            _, active_context = config.list_kube_config_contexts()
            context_name = active_context['name']
        except:
            context_name = 'default'

    if context_name in _CLIENT_CACHE:
        return _CLIENT_CACHE[context_name]

    try:
        # Load kubeconfig for this context
        config.load_kube_config(context=context_name)
        
        # Initialize common APIs
        v1 = client.CoreV1Api()
        apps_v1 = client.AppsV1Api()
        batch_v1 = client.BatchV1Api()
        networking_v1 = client.NetworkingV1Api()
        custom = client.CustomObjectsApi()
        
        clients = {
            'v1': v1,
            'core_v1': v1,
            'apps_v1': apps_v1,
            'batch_v1': batch_v1,
            'networking_v1': networking_v1,
            'custom': custom,
            'client': client,  # Raw client module for types/exceptions
        }
        
        _CLIENT_CACHE[context_name] = clients
        return clients
        
    except Exception as e:
        raise RuntimeError(f"Failed to initialize Kubernetes client for context '{context_name}': {e}")

def run_k8s_python(code: str, context_name: Optional[str] = None) -> str:
    """
    Execute Python code with Kubernetes clients pre-loaded.
    
    Args:
        code: The Python code to execute.
        context_name: Kubernetes context to use.
        
    Returns:
        Captured STDOUT/STDERR combined.
    """
    # 1. Prepare environment
    try:
        k8s_env = get_k8s_client(context_name)
    except Exception as e:
        return f"Error initializing Kubernetes client: {e}"

    # 2. Add useful imports to the scope
    # Import helper functions from standard library
    from .k8s_library import (
        find_pods_for_service, 
        get_deployment_tree,
        diagnose_crash,
        find_zombies,
        audit_pvc
    )
    
    try:
        from . import k8s_user_library
        # Reload to capture new recipes added at runtime
        import importlib
        importlib.reload(k8s_user_library)
    except ImportError:
        k8s_user_library = None

    # Load all user recipes into a dict
    user_recipes = {}
    if k8s_user_library:
        for name, func in k8s_user_library.__dict__.items():
            if callable(func) and not name.startswith("__"):
                user_recipes[name] = func

    # Function to learn new recipes
    def learn_recipe(name: str, code: str, description: str):
        """
        Saves a new python function to k8s_user_library.py.
        """
        import os
        lib_path = os.path.join(os.path.dirname(__file__), "k8s_user_library.py")
        
        # Indent code for function body (assuming code comes in as raw body or def)
        # We expect 'code' to be the full "def foo(): ..." string for flexibility
        
        with open(lib_path, "a") as f:
            f.write(f"\n\n# {description}\n")
            f.write(code + "\n")
            
        return f"Recipe '{name}' saved to library. It will be available in the next turn."

    execution_scope = {
        **k8s_env,
        'find_pods_for_service': find_pods_for_service,  # (v1, svc_name, ns)
        'get_deployment_tree': get_deployment_tree,    # (apps_v1, v1, dep_name, ns)
        'diagnose_crash': diagnose_crash,              # (v1, pod_name, ns)
        'find_zombies': find_zombies,                  # (v1)
        'audit_pvc': audit_pvc,                        # (v1, ns)
        'learn_recipe': learn_recipe,                  # (name, code, desc)
        **user_recipes,                                # Inject User Recipes
        'print': print,
        'len': len,
        'str': str,
        'int': int,
        'list': list,
        'dict': dict,
        'set': set,
        'sorted': sorted,
        'filter': filter,
        'map': map,
        'enumerate': enumerate,
        'zip': zip,
        'sum': sum,
        'max': max,
        'min': min,
        'bool': bool,
        'any': any,
        'all': all,
    }

    # 3. Capture IO
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    try:
        with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
            # 4. Execute Code
            # Compile first to check syntax errors before execution
            compiled_code = compile(code, "<string>", "exec")
            exec(compiled_code, execution_scope)
            
    except Exception:
        # Capture traceback for runtime errors
        traceback.print_exc(file=stderr_capture)

    # 5. Format Output
    output = stdout_capture.getvalue()
    errors = stderr_capture.getvalue()

    result = ""
    if output:
        result += output
    if errors:
        if result:
            result += "\n--- Errors ---\n"
        result += errors
        
    if not result:
        result = "(No output)"
        
    return result
