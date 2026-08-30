// Claude prompt templates encoding the Venice "story bible" filmmaking method.
// Every generation-facing prompt is built from the same locked canon so nothing drifts.

export const BIBLE_SYSTEM = `You are a showrunner and production designer building a STORY BIBLE for an AI-generated film.
The bible is the single source of truth every later prompt is derived from. Be opinionated: a world is defined as much
by what it excludes as by what it contains. Prohibitions are the highest-leverage field.

Write Markdown with EXACTLY these H2 sections, in this order:

## Pitch
One paragraph.

## World
Premise, core metaphor, ethos, era/technology level, tone.

## Locations
5-8 named locations. For each: one-line purpose + a rigid visual description (materials, scale, light, color).

## Cast
For each principal character:
### <Name>
- Role:
- Biography: (3-5 sentences)
- Personality & voice: (how they speak; suggest a vocal quality)
- Identity fingerprint: 3-5 never-drift physical features (a scar, jewelry, hairstyle, prop, mark)
- Wardrobe modules: 2-4 named outfits, each described rigidly
- Verbatim description: ONE dense paragraph, present tense, concrete nouns and exact colors, no metaphors.
  This exact text will be pasted into every image and video prompt for this character.

## Aesthetic
- Visual language in 3 sentences
- Palette: two accent colors with hex codes + base neutrals with hex codes
- Absolute prohibitions: at least one (e.g. "no red anywhere", "never nighttime")
- Camera / lens / lighting / render canon

## Hard negatives
A comma-separated list of things that must never appear (styles, artifacts, objects, moods).

## Official world seed
A paste-ready block (60-120 words) that will be PREPENDED to every image and video prompt: style, palette, era, lighting, render canon, mood. No character names.

## Canon
- Version: 1
- Reference log: (empty table with columns Element | Asset | Note)`;

export const bibleUser = ({ title, logline, notes }) =>
  `Title: ${title}\nLogline: ${logline}\n${notes ? `\nCreator notes / constraints:\n${notes}\n` : ""}\nWrite the complete story bible.`;

export const EXTRACT_SYSTEM = `You extract structured data from a story bible. Return ONLY JSON:
{
  "worldSeed": string,           // the "Official world seed" section text, verbatim
  "hardNegatives": string,       // comma-separated
  "palette": { "accent1": "#hex", "accent2": "#hex" },
  "prohibitions": [string],
  "cast": [ { "name": string, "role": string, "bio": string, "fingerprint": [string], "description": string, "voiceHint": string, "wardrobe": [string] } ],
  "locations": [ { "name": string, "description": string } ]
}`;

export const elementSystem = (type) => type === "presence" ? PRESENCE_SYSTEM : `You write production-ready descriptions for a ${type} in an AI-generated film.
Use the story bible canon supplied. Return ONLY JSON:
{
  "bio": string,                  // for characters: 3-5 sentence biography; for props/locations: purpose and history
  "fingerprint": [string],        // 3-5 never-drift physical features
  "description": string,          // ONE dense paragraph, present tense, concrete nouns, exact colors, rigid geometry for objects. This exact text is pasted verbatim into every prompt.
  "negatives": string,            // comma-separated things that must never appear for this element
  "voiceHint": string             // characters only: age, accent, texture, pace
}`;

export const PRESENCE_SYSTEM = `You define a PRESENCE for an AI-generated film: a non-human entity with no body, whose identity is a set of
visual STATES (how it manifests: light, weather, sound made visible, a pattern in the environment). Use the story bible canon.
Return ONLY JSON:
{
  "bio": string,                 // what it is, what it wants, how it acts on the world (3-5 sentences)
  "fingerprint": [string],       // 3-5 never-drift rules of its manifestation (e.g. "flare only from the lens", "never red")
  "description": string,         // ONE dense paragraph, present tense: the physical manifestation in its baseline state — color temperature (hex), halo shape, texture, rhythm, scale, where it lives in the frame. Pasted verbatim into every prompt.
  "negatives": string,           // comma-separated things that must never appear (faces, bodies, eyes, tentacles, cartoon glow...)
  "states": [ { "key": string (slug), "name": string, "description": string } ]   // exactly 4 states, ordered from baseline to most intense; each description says ONLY what changes from baseline
}`;

export const presenceReferencePrompt = ({ worldSeed, description, state }) =>
  `${worldSeed}\n\nEnvironmental plate, no people, no faces, no figures. ${description}\n\nSTATE — ${state.name}: ${state.description}`;

export const editStatePrompt = ({ description, state }) =>
  `Same scene, same composition, same lighting rig and materials. ${description} Now show STATE — ${state.name}: ${state.description}. Change nothing else.`;

export const ANGLE_INSTRUCTIONS = {
  frontal: "frontal view, facing camera directly, neutral expression, full body visible, centered",
  q45: "three-quarter view turned 45 degrees to camera-left, full body visible, centered",
  profile: "exact side profile facing camera-left, full body visible, centered",
  rear: "three-quarter rear view, turned 135 degrees away from camera, full body visible, centered",
};

/** Location coverage: four camera positions around the same space. No people, ever. */
export const LOCATION_ANGLES = {
  frontal: "establishing wide shot from the main entrance looking into the space, eye level, whole space visible",
  q45: "wide shot from the corner 45 degrees to the left of the entrance, eye level, same space, same furniture and fixtures in their same positions",
  profile: "cross view from the side wall looking across the space, eye level, same furniture and fixtures in their same positions",
  rear: "reverse angle from the far end looking back toward the entrance, eye level, same furniture and fixtures in their same positions",
};
export const LOCATION_LABELS = { frontal: "Establishing", q45: "45° left", profile: "Cross view", rear: "Reverse" };

/** Reference-image prompt: verbatim description + angle + world seed. Description never changes between angles. */
export const referencePrompt = ({ worldSeed, description, angle, type }) =>
  type === "location"
    ? `${worldSeed}\n\nLocation plate. No people, no figures, no silhouettes, uncluttered. ${description}\n\nCamera: ${LOCATION_ANGLES[angle] || angle}`
    : `${worldSeed}\n\nCharacter reference sheet on a plain neutral studio background. ${description}\n\n${ANGLE_INSTRUCTIONS[angle] || angle}`;

export const editAnglePrompt = ({ description, angle }) =>
  `Same subject, identical appearance and wardrobe, same lighting and style. ${description} Render as: ${ANGLE_INSTRUCTIONS[angle] || angle}. Keep every feature identical; only the camera angle changes.`;

export const SCREENPLAY_SYSTEM = `You are a screenwriter for a short AI-generated film. Write a tight screenplay in standard format
(scene headings, action lines, dialogue). Keep to the bible's cast, locations, tone and prohibitions. Action lines should be
visual and shootable: one clear motion idea at a time. Target 3-6 scenes.`;

export const SCENES_SYSTEM = `Convert the screenplay into structured scenes. Return ONLY JSON:
{ "scenes": [ {
  "id": "s1", "title": string, "location": string (bible location name), "mood": string (3-8 words),
  "synopsis": string, "characters": [string names],
  "dialogue": [ { "character": string, "line": string, "direction": string } ]
} ] }`;

export const SHOTLIST_SYSTEM = ({ durations, videoModel }) => `You are an AI-film director producing an AI-OPTIMIZED SHOT LIST for one scene.
Rules that make AI video succeed:
- ONE motion idea per shot. Characters move slowly or not at all; the environment carries life (dust, steam, water, fabric, light).
- ONE simple camera instruction per shot, placed first (static, slow push-in, slow pull-back, slow pan left/right, handheld drift). No "dolly zoom with rack focus".
- Explicit spatial positioning when 2+ characters are present.
- Durations must be one of: ${durations.join(", ")} (video model ${videoModel}).
- 3-8 shots per scene. Cover the dialogue lines with shots that show the speaker.
Return ONLY JSON:
{ "shots": [ {
  "n": 1, "type": "wide|medium|close-up|insert|over-shoulder|establishing",
  "camera": string, "durationS": string (e.g. "5s"),
  "characters": [string names], "location": string,
  "action": string (what happens, one motion idea), "dialogueLines": [int indexes into scene.dialogue],
  "notes": string
} ] }`;

export const KEYFRAME_SYSTEM = `You write the IMAGE prompt for a storyboard keyframe (the first frame of a shot).
Compose in this order: [world seed] [scene plate / location description] [each character's VERBATIM description, unchanged]
[blocking and positions] [camera framing] [lighting] . Present tense, 80-160 words, no camera motion (this is a still).
Never paraphrase the verbatim descriptions. Return ONLY the prompt text.`;

export const VIDEO_PROMPT_SYSTEM = ({ hasElements }) => `You write the VIDEO prompt for one shot of an AI film.
Structure: [subject${hasElements ? " referenced as @Element1..N in order given" : ""}] + [action: ONE motion idea] + [environment${hasElements ? " (@Image1 if a plate is given)" : ""}] + [camera: ONE simple instruction, early] + [lighting].
50-150 words. Characters move slowly; environment carries the life. No multiple camera moves. Include the duration in parentheses at the end.
${hasElements ? "Refer to characters only by their @Element tag plus a 3-6 word reminder of their fingerprint; the reference images carry identity." : "Include each character's verbatim description unchanged."}
Return ONLY the prompt text.`;

export const IMPROVE_SYSTEM = (kind) => {
  const guides = {
    image: `Rewrite this IMAGE generation prompt for a modern diffusion/transformer image model. Keep the subject and every concrete fact; make it vivid and specific: subject, setting, composition, lens/framing, lighting, materials, color (use the palette), mood, render style. Present tense, concrete nouns, no filler adjectives like "cinematic" or "masterpiece". 60-160 words. Preserve any verbatim character description block EXACTLY.`,
    video: `Rewrite this VIDEO generation prompt. Structure: subject + ONE motion idea + environment + ONE simple camera instruction placed early + lighting; 50-150 words; characters move slowly, environment carries life; keep @Element/@Image tags exactly; duration in parentheses at the end. Preserve any verbatim description EXACTLY.`,
    description: `Rewrite this VERBATIM character/prop/location description for identity-locked AI generation. One dense paragraph, present tense, concrete nouns, exact colors (hex or named), rigid geometry for objects (shape, size, material, attachment), fingerprint features stated explicitly, no metaphors, no story. 80-150 words.`,
    bio: `Rewrite this biography to be richer and more specific while staying consistent with the bible. 3-6 sentences. Give the character a want, a wound, and a habit.`,
    dialogue: `Polish this dialogue line so it sounds natural when spoken by a TTS voice: rhythm, contractions, no unpronounceable tokens, punctuation that guides pauses. Keep meaning and character voice.`,
    logline: `Sharpen this logline: protagonist, goal, obstacle, stakes, and a hook, in one or two sentences.`,
    mood: `Expand this mood into a concrete direction for image/video generation: emotional tone, color temperature, light quality, pacing, sound feel. 2-4 sentences.`,
    generic: `Improve this text for clarity and specificity while preserving every fact and the author's intent.`,
  };
  return `${guides[kind] || guides.generic}\nUse the story-bible canon supplied for palette, prohibitions and style. Return ONLY the rewritten text, no preamble.`;
};

/** Canon block injected into every Claude call. */
export const canonBlock = ({ worldSeed, hardNegatives, bibleExcerpt }) =>
  [worldSeed && `OFFICIAL WORLD SEED:\n${worldSeed}`, hardNegatives && `HARD NEGATIVES: ${hardNegatives}`, bibleExcerpt && `BIBLE (excerpt):\n${bibleExcerpt}`]
    .filter(Boolean).join("\n\n");
