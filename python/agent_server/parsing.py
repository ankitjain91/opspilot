
import re
import json
from .config import CONFIDENCE_THRESHOLD

def parse_confidence_from_response(response: str) -> float:
    """
    Extract confidence score from model response.
    The model is instructed to include "confidence": 0.X in its JSON.
    Returns 1.0 if not found (assume confident).
    """
    try:
        # Look for confidence in JSON
        match = re.search(r'"confidence"\s*:\s*([\d.]+)', response)
        if match:
            return float(match.group(1))

        # Look for UNCERTAIN or UNSURE markers
        response_lower = response.lower()
        if any(marker in response_lower for marker in ['uncertain', 'unsure', 'not confident', 'need more info', 'escalate']):
            return 0.5

        return 1.0  # Default: assume confident
    except:
        return 1.0

def clean_json_response(response: str) -> str:
    """Extract the first valid JSON object using brace counting."""
    # Remove BOM, zero-width chars, and normalize whitespace
    text = response.strip()
    text = text.replace('\ufeff', '').replace('\u200b', '').replace('\u200c', '').replace('\u200d', '')

    # Remove markdown code blocks
    match = re.search(r'```(?:json)?\s*(\{.*)', text, re.DOTALL)
    if match:
        text = match.group(1)
    
    start = text.find('{')
    if start == -1:
        return response
        
    count = 0
    in_string = False
    escape = False
    
    for i, char in enumerate(text[start:], start):
        if char == '"' and not escape:
            in_string = not in_string
        elif char == '\\' and in_string:
            escape = not escape
        else:
            escape = False
            
        if not in_string:
            if char == '{':
                count += 1
            elif char == '}':
                count -= 1
                
            if count == 0:
                return text[start:i+1]
                
    match = re.search(r'(\{.*\})', response, re.DOTALL)
    return match.group(1) if match else response

def parse_supervisor_response(response: str) -> dict:
    """Parse the Brain's JSON response with robust fallback extraction."""
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        return {
            "thought": data.get("thought", ""),
            "plan": data.get("plan", ""),
            "next_action": data.get("next_action", "respond"),
            "confidence": data.get("confidence", 1.0),
            "batch_commands": data.get("batch_commands"),
            "execution_steps": data.get("execution_steps"),
            "hypothesis": data.get("hypothesis"),
            "final_response": data.get("final_response"),
            "tool": data.get("tool"),
            "args": data.get("args"),
        }
    except Exception as e:
        print(f"Error parsing supervisor output: {e}\nRaw: {response[:500]}...")

        # Try to extract fields individually from malformed JSON
        thought = ""
        plan = ""
        next_action = "respond"
        confidence = 1.0
        final_response = None
        hypothesis = None
        execution_steps = None

        thought_match = re.search(r'"thought"\s*:\s*"([^"]*)"', response)
        if thought_match:
            thought = thought_match.group(1)

        plan_match = re.search(r'"plan"\s*:\s*"([^"]*)"', response)
        if plan_match:
            plan = plan_match.group(1)

        action_match = re.search(r'"next_action"\s*:\s*"(delegate|respond|invoke_mcp|batch_delegate|create_plan)"', response)
        if action_match:
            next_action = action_match.group(1)

        confidence_match = re.search(r'"confidence"\s*:\s*([0-9.]+)', response)
        if confidence_match:
            try:
                confidence = float(confidence_match.group(1))
            except:
                confidence = 1.0

        response_match = re.search(r'"final_response"\s*:\s*"([^"]*(?:\\"[^"]*)*)"', response, re.DOTALL)
        if response_match:
            final_response = response_match.group(1).replace('\\"', '"')
        
        hypothesis_match = re.search(r'"hypothesis"\s*:\s*"([^"]*)"', response)
        if hypothesis_match:
            hypothesis = hypothesis_match.group(1)
        
        # execution_steps extraction is too complex for fallback regex

        # If we got something useful, return partial parse
        if thought or plan:
            return {
                "thought": thought or "Partial parse from malformed JSON",
                "plan": plan or "Continue investigation",
                "next_action": next_action,
                "confidence": confidence,
                "final_response": final_response,
                "hypothesis": hypothesis,
                "execution_steps": execution_steps,
                "tool": None,
                "args": None,
            }

        # Total failure - return error
        return {
            "thought": "Failed to parse brain response. Defaulting to final response.",
            "plan": "Error in planning.",
            "next_action": "respond",
            "confidence": 0.0,
            "final_response": f'I had an internal error planning the next step. The model may have produced malformed JSON.',
        }

def parse_worker_response(response: str) -> dict:
    """Parse the Worker's JSON response to get command and thought.

    Includes fallback extraction for common malformed patterns.
    """
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        cmd = data.get("command", "")
        thought = data.get("thought", "Translating plan to command...")

        if not cmd:
            raise ValueError("No command found in worker response")

        return {"command": cmd, "thought": thought}
    except Exception as e:
        print(f"Error parsing worker output: {e}\nRaw: {response[:500]}...")

        # Fallback 1: Look for kubectl command in text (most common)
        match = re.search(r'(kubectl\s+[\w-]+\s+.+?)(?:\n|$)', response, re.IGNORECASE)
        if match:
            return {"command": match.group(1).strip(), "thought": "Extracted kubectl command from malformed JSON."}

        # Fallback 2: Look for "command": "..." pattern even if JSON is broken
        match = re.search(r'"command"\s*:\s*"([^"]+)"', response)
        if match:
            return {"command": match.group(1), "thought": "Extracted from command field."}

        # Fallback 3: Look for thought and command separately
        thought_match = re.search(r'"thought"\s*:\s*"([^"]*)"', response)
        cmd_match = re.search(r'"command"\s*:\s*"([^"]*)"', response)
        if cmd_match:
            thought = thought_match.group(1) if thought_match else "Recovered from partial JSON"
            return {"command": cmd_match.group(1), "thought": thought}

        return {"command": "", "thought": "Failed to parse command - no kubectl found in response."}

def parse_reflection(response: str) -> dict:
    """Parse the reflection JSON."""
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        return {
            "thought": data.get("thought", ""),
            "found_solution": data.get("found_solution", False),
            "hypothesis_status": data.get("hypothesis_status", None),
            "revised_hypothesis": data.get("revised_hypothesis", None),
            "final_response": data.get("final_response", ""),
            "next_step_hint": data.get("next_step_hint", "")
        }
    except Exception as e:
        return {
            "thought": f"Failed to parse reflection: {e}",
            "found_solution": False,
            "hypothesis_status": None,
            "final_response": "",
            "next_step_hint": "Check output manually",
        }
