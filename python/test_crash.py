
try:
    print("Testing '${...}' format string...")
    s = "DO NOT use ${...}"
    s.format(foo="bar")
    print("✅ No crash for ${...}")
except IndexError as e:
    print(f"❌ Crash verified: {e}")
except KeyError as e:
    print(f"❌ KeyError: {e}")
except Exception as e:
    print(f"❌ Other error: {e}")

try:
    print("\nTesting escaped '${{...}}'...")
    s = "DO NOT use ${{...}}"
    res = s.format(foo="bar")
    print(f"✅ Works! Result: {res}")
except Exception as e:
    print(f"❌ Failed: {e}")
