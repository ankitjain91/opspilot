
from ..common.k8s_cheatsheet import K8S_CHEAT_SHEET
# from ..common.azure_cheatsheet import AZURE_CHEAT_SHEET  # REMOVED: Dead code cleanup
# from ..common.regex_cheatsheet import REGEX_CHEAT_SHEET  # REMOVED: Dead code cleanup
from .personality import PERSONALITY_PROMPT
from .rules import DECISION_RULES_PROMPT
from .instructions import INSTRUCTIONS_PROMPT
from .azure_crossplane_expertise import AZURE_CROSSPLANE_EXPERTISE

# Assemble the monolithic prompt
SUPERVISOR_PROMPT = (
    PERSONALITY_PROMPT + "\n" +
    DECISION_RULES_PROMPT + "\n" +
    K8S_CHEAT_SHEET + "\n" +
    AZURE_CROSSPLANE_EXPERTISE + "\n" +  # NEW: Azure & Crossplane domain expertise
    # AZURE_CHEAT_SHEET + "\n" +  # REMOVED: Dead code cleanup
    # REGEX_CHEAT_SHEET + "\n" +  # REMOVED: Dead code cleanup
    INSTRUCTIONS_PROMPT
)
