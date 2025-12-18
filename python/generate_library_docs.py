
import sys
import os
import inspect

sys.path.append(os.path.join(os.getcwd(), 'python'))

try:
    from agent_server.tools import k8s_library
except ImportError:
    sys.path.append(os.getcwd())
    from agent_server.tools import k8s_library

try:
    from agent_server.tools import k8s_user_library
except ImportError:
    k8s_user_library = None

def generate_docs():
    functions = inspect.getmembers(k8s_library, inspect.isfunction)
    
    print("MATCHING FUNCTIONS (Standard Lib):")
    for name, func in functions:
        if func.__module__ == k8s_library.__name__:
            sig = inspect.signature(func)
            doc = inspect.getdoc(func) or "No documentation."
            
            print(f"- `{name}{sig}`")
            for line in doc.split('\n'):
                print(f"  {line}")
            print()

    if k8s_user_library:
        print("USER RECIPES:")
        user_funcs = inspect.getmembers(k8s_user_library, inspect.isfunction)
        for name, func in user_funcs:
             if func.__module__ == k8s_user_library.__name__:
                sig = inspect.signature(func)
                doc = inspect.getdoc(func) or "No documentation."
                print(f"- `{name}{sig}`")
                for line in doc.split('\n'):
                    print(f"  {line}")
                print()

if __name__ == "__main__":
    generate_docs()
