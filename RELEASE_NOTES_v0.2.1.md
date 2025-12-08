## OpsPilot v0.2.1

### Highlights
- Major UI polish across Deep Dive (darker cards, richer resource details, better ConfigMap/Secret display, normalized events/timestamps).
- Smarter autonomous agent: reflection prompts, recovery plans, placeholder/name auto-detection, higher tool budgets, and richer playbooks/KB.
- Knowledge base overhaul with detailed, actionable articles for common k8s failures, plus automated embeddings hook in the build.
- Dashboard fixes: node health meter now shows green when all nodes are Ready; AI chat panel stability fixes.

### Installation

**macOS**  
If you see “Apple could not verify…”: right-click the app → Open → Open. Or run:  
`xattr -cr /Applications/OpsPilot.app`

**Windows**  
If SmartScreen shows “Windows protected your PC”: click **More info** → **Run anyway**.

**Linux**  
- AppImage: Right-click → Properties → Permissions → allow executing as program.  
- Debian/Ubuntu: `sudo dpkg -i OpsPilot_Linux_x64_*.deb`
