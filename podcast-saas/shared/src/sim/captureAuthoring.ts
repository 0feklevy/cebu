/**
 * THE AUTHORING CONTRACT for capture-compatible simulations — the guidance half of the rule the
 * publish validator enforces.
 *
 * FlowVid renders every simulation twice: once in a viewer that has a network, and once inside an
 * export capture container that has NONE (`--network none` is what makes SSRF impossible by
 * construction). A simulation that boots only in the first place looks perfectly healthy right up
 * until an export renders it as a dead black canvas — the v0.1.26 incident, which cost days.
 *
 * This text is injected into the generation prompts so authored simulations start out offline-safe.
 * It is GUIDANCE, deliberately: `validateCaptureCompatibility()` at publish time is the AUTHORITY,
 * because a model that ignores an instruction must still be unable to ship a package that cannot
 * render. Keep the two in agreement — every rule below is one the validator actually checks.
 */
export const CAPTURE_AUTHORING_RULES = `## OFFLINE / CAPTURE-COMPATIBILITY RULES (enforced at publish time)

The simulation is rendered for video export inside a container with NO network access. A package
that needs the public internet to boot cannot be exported and will be REJECTED at publish.

1. Do NOT load runtime libraries from a CDN. No \`<script src="https://…">\`, and no import map
   entry pointing at jsDelivr / unpkg / esm.sh / cdnjs, unless that exact library AND version is
   one the platform vendors (currently: three@0.169.0, including three/addons/*). Anything else is
   rejected with the URL named.
2. Do NOT import an absolute URL from JavaScript (\`import x from 'https://…'\`). An import map
   cannot redirect it, so it always escapes to the network.
3. Every model, texture, shader, audio file, JSON config and stylesheet the simulation needs at
   runtime MUST be inside the package and referenced RELATIVELY (\`./models/bird.glb\`).
4. Do NOT rely on remote fonts (Google Fonts and similar). Capture removes them so the layout is
   deterministic; an icon font's ligatures will render as their raw names. Use a local font or
   plain text labels.
5. Do NOT require \`fetch()\` of any remote URL to initialise. A local \`fetch('./data.json')\` is
   fine; a failed optional fetch must not block rendering.
6. The simulation must reach its first painted frame with no network at all, and must keep
   animating after \`startScript\` — a frozen or blank canvas fails the rendering sanity gate.
7. Never reference anything above the package root (\`../../\`), and never rely on a file that is
   not shipped in the package.`;
