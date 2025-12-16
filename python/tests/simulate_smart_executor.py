
import asyncio
from typing import TypedDict, Literal, List
import copy

# Mock Types
class ReflectionData(TypedDict, total=False):
    directive: Literal['CONTINUE', 'RETRY', 'SOLVED', 'ABORT']
    verified_facts: List[str]
    reason: str

class AgentState(TypedDict):
    execution_plan: list
    retry_count: int
    step_status: str
    last_reflection: ReflectionData
    accumulated_evidence: list
    next_action: str

# Helper mocks
def get_current_step(plan):
    for step in plan:
        if step['status'] in ['pending', 'in_progress', 'retrying']:
            return step
    return None

def mark_step_completed(plan, step_num):
    plan[step_num-1]['status'] = 'completed'
    return plan

def mark_step_skipped(plan, step_num, reason):
    plan[step_num-1]['status'] = 'skipped'
    return plan

# EXTRACTED LOGIC FROM plan_executor.py
async def transition_logic(state: AgentState):
    plan = state.get('execution_plan')
    previous_reflection = state.get('last_reflection')
    retry_count = state.get('retry_count', 0)
    current_step_status = state.get('step_status', 'pending')
    
    active_step = get_current_step(plan)
    
    if active_step and current_step_status == 'active' and previous_reflection:
        step_idx = active_step['step'] - 1
        directive = previous_reflection.get('directive', 'CONTINUE')
        
        if directive == 'SOLVED':
            return {**state, 'next_action': 'synthesize'} # Mock
            
        elif directive == 'ABORT':
            return {**state, 'next_action': 'supervisor'}
            
        elif directive == 'RETRY':
             if retry_count < 3:
                state['retry_count'] = retry_count + 1
             else:
                plan = mark_step_skipped(plan, active_step['step'], reason="Max retries")
                state['retry_count'] = 0
                state['last_reflection'] = None
                state['step_status'] = 'pending'
                state['execution_plan'] = plan
                
        elif directive == 'CONTINUE':
            plan = mark_step_completed(plan, active_step['step'])
            
            new_facts = previous_reflection.get('verified_facts', [])
            if new_facts:
                state.setdefault('accumulated_evidence', []).extend(new_facts)
            
            state['retry_count'] = 0
            state['last_reflection'] = None
            state['step_status'] = 'pending'
            state['execution_plan'] = plan
            
    return state

# TEST CASES
async def run_tests():
    # TEST 1: RETRY
    print("Test 1: RETRY logic")
    state = {
        'execution_plan': [{'step': 1, 'status': 'in_progress'}, {'step': 2, 'status': 'pending'}],
        'retry_count': 0, 'step_status': 'active',
        'last_reflection': {'directive': 'RETRY'}
    }
    new_state = await transition_logic(copy.deepcopy(state))
    assert new_state['retry_count'] == 1, f"Expected retry_count 1, got {new_state['retry_count']}"
    assert new_state['execution_plan'][0]['status'] == 'in_progress', "Step should remain in progress"
    print("✅ RETRY passed")

    # TEST 2: SOLVED
    print("Test 2: SOLVED logic")
    state['last_reflection'] = {'directive': 'SOLVED'}
    new_state = await transition_logic(copy.deepcopy(state))
    assert new_state['next_action'] == 'synthesize', "Should go to synthesis"
    print("✅ SOLVED passed")

    # TEST 3: CONTINUE
    print("Test 3: CONTINUE logic")
    state['last_reflection'] = {'directive': 'CONTINUE', 'verified_facts': ['Pod is dead']}
    new_state = await transition_logic(copy.deepcopy(state))
    assert new_state['execution_plan'][0]['status'] == 'completed', "Step should be completed"
    assert 'Pod is dead' in new_state['accumulated_evidence'], "Evidence should be collected"
    print("✅ CONTINUE passed")

    # TEST 4: MAX RETRIES
    print("Test 4: MAX RETRIES logic")
    state = {
        'execution_plan': [{'step': 1, 'status': 'in_progress'}, {'step': 2, 'status': 'pending'}],
        'retry_count': 3, 'step_status': 'active',
        'last_reflection': {'directive': 'RETRY'}
    }
    new_state = await transition_logic(copy.deepcopy(state))
    assert new_state['execution_plan'][0]['status'] == 'skipped', "Step should be skipped"
    assert new_state['retry_count'] == 0, "Retry count should reset"
    print("✅ MAX RETRIES passed")

if __name__ == "__main__":
    asyncio.run(run_tests())
