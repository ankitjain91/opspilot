from agent_server import SUPERVISOR_PROMPT
print("Prompt length:", len(SUPERVISOR_PROMPT))
try:
    formatted = SUPERVISOR_PROMPT.format(
        kb_context="KB",
        examples="EX",
        query="Q",
        kube_context="CTX",
        cluster_info="INFO",
        command_history="CMD",
        mcp_tools_desc="MCP"
    )
    print("Formatting successful!")
except Exception as e:
    print(f"Formatting failed: {e!r}")
    import traceback
    traceback.print_exc()
