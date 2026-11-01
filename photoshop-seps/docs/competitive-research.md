# What separation software gets wrong, and what Ecko Seps does about it

Researched November 2026. Independent reviews of screen-print separation
software are rare: most of what exists is vendor support pages and threads
on printing forums (The Shirt Board, Signs101, T-Biz). Forum pages could not
be opened from the research environment, so the notes below come from search
summaries of those threads, the vendors' own support and troubleshooting
pages, and trade articles. Treat the vendor pages as partial: they list the
problems the vendors chose to document.

## Who's out there

| Product | Type | What users say |
|---|---|---|
| UltraSeps (+ QuikSeps entry tier) | Photoshop plug-in (actions + plug-in), Win/Mac | Most praised for sim process quality. Seen as weaker for spot color: the developer suggested switching to sim process when a user's spot seps mis-selected areas. Support pages document Photoshop updates breaking underbase/highlight channels, "Color Book" errors after Photoshop 24, and a multi-step manual install |
| T-Seps (T-Biz Network) | Photoshop plug-in, ~$345 | Vendor notice: v3.5 breaks on Photoshop 24.0.1+ with a "program error". Troubleshooting pages cover plug-ins that won't load, extension errors, reinstalling with Photoshop closed |
| Separation Studio NXT / Spot Process (Freehand Graphics) | Stand-alone, subscription bundles with AccuRIP | One user found it hard to tweak seps and not user-friendly. Vendor admits over-designed vector files make too many separations or won't open (workaround: export a 300 DPI PNG first). Older versions used a hardware dongle |
| AccuRIP | RIP (film output) | Output stopped after a Creative Suite update for one user. Dropped support for the Epson 1430, sending users to PrintFab |
| SimpleSeps, SepForge, AI Separations | Plug-in / app | SepForge (Mac-only) markets "fine-tune every channel", which tells you that is a gap elsewhere |

## Complaints and how Ecko Seps answers them

| Complaint | Ecko Seps' answer |
|---|---|
| **Photoshop updates break the plug-in** (T-Seps on 24.0.1+, UltraSeps channel bugs in CC 2015, Color Book errors after v24). Older plug-ins are built on actions, scripting and CEP panels, and Adobe is retiring CEP. | Built on UXP, Adobe's current plug-in system. The separation maths is plain JavaScript that does not depend on Photoshop at all (tested on its own). Photoshop is only used to read pixels and write channels. No recorded actions, no Color Books. |
| **Pantone books removed from Photoshop (2022).** Spot channels built from a missing book render black or gray, and you can't add a book color if the `.acb` is gone. | Spot channels are made from plain RGB values plus the ink name, never from a Color Book. Import your licensed PMS library (`.ase` from Pantone Connect, `.aco`, `.csv`, `.gpl`) and every screen is named after its PMS ink, so the RIP and the mixing room see "PMS 186 C". |
| **Muddy, dull sim-process colors and a heavy ink deposit.** | Inks are picked from the *strong* end of each color group, and halftones fade them toward the shirt, so tones aren't built from washed-out averages. At most 3 inks mix at any point ("Inks per spot"). An "Ink build-up: Soft hand" mode lays dots side by side. The report warns where color ink stacks over 220%. |
| **Weak underbase under saturated colors.** A lightness-only base gives bright red or royal blue only 40–50% white, so they print dull. | The underbase is worked out per ink from lightness *and* chroma, so red and royal blue get a full base and navy gets very little. Density is adjustable. |
| **Underbase showing around the colors.** | Underbase choke (0–4 px) is built in. The preview shows any white that would peek out. |
| **Moiré.** | One angle and frequency on every sim screen (default 22.5°, 55 lpi) keeps dots nested. CMYK uses the C 15°/M 75°/Y 0°/K 45° set. Index and FM output have no screen angle at all. |
| **Spot seps mis-select areas, with specks and fake colors from anti-aliased edges.** | Edge pixels are ignored when picking colors (a 3-color logo gives 3 screens, not 4). Near-duplicate colors are merged, a majority filter removes stray pixels, edges are smoothed, and trap (spread) is optional. |
| **Small accents vanish** (the red eye or logo dot gets averaged away). | "Accent rescue": if a small group of pixels has no close ink, two near-duplicate inks are merged to free a screen for it. |
| **Specks and tiny dots that won't hold on the mesh.** | Smallest/largest dot limits round unholdable dots instead of cutting them, so tone is kept. Lone stray pixels are removed from every plate. The report counts what was cleaned. |
| **Black box, hard to tweak.** | Every screen is listed with its ink, coverage and mesh. Rename, recolor (nearest library inks first), lock, reorder, delete or add inks, then re-separate with exactly those inks. Every setting is in plain words and can be reset to the preset. |
| **No idea how it will print until you burn screens.** | An on-shirt preview using the same press model as the separation (opaque inks, underbase, bare-fabric opacity, dot gain), plus a match score in ΔE2000 that says plainly whether it will look like the art. Single-plate film views. |
| **How many colors do I need?** | Buttons for 2, 4, 6, 8 and 10 screens, plus **Auto**, which finds the fewest screens that still match. The count is the total number of screens (underbase and highlight white included), so it equals press heads. |
| **Confusing setup, too many steps.** | Three choices (job type, shirt color, screens), then one button. Seven presets cover dark/light sim process, dark/light index, spot, CMYK and one-color. |
| **Slow.** | The preview is a fast proof (about 1 second). Full resolution runs only for output. |
| **Expensive, dongles, activation servers.** | Runs on your computer, with no account, no dongle and no upload. |
| **Over-designed vector files make too many seps or won't open.** | Works from the flattened pixels of whatever is open in Photoshop, with a fixed screen count you choose. |
| **Film output needs a separate RIP.** | Exports 1-bit TIFF films directly. Halftone dots (round, ellipse, square, diamond, line) at any frequency and angle, FM/stochastic with a minimum dot, index pixels, or solid. 300–2400 dpi, registration marks, labels, mirror for emulsion side, plus a job sheet with print order and mesh counts. You can still send continuous-tone channels to your own RIP. |

## Sources

- UltraSeps support and bug pages: https://ultraseps.com/support.php, https://ultraseps.com/photoshop-2015-install.php, https://m.ultraseps.com/photoshop-cc-2015-bugs/
- UltraSeps film output settings (LPI, angles, mesh): https://ultraseps.com/film-positive-output-settings.pdf
- T-Seps Photoshop update notice and troubleshooting: https://t-biznetwork.com/t-seps/troubleshooting/important-photoshop-update-issues/, https://t-biznetwork.com/t-seps/troubleshooting/, https://t-biznetwork.com/t-seps-plug-ins-wont-load-support/
- T-Biz on Pantone in Photoshop 24+: https://t-biznetwork.com/t-seps/pantonechannelseps/
- T-Biz sim process articles: https://t-biznetwork.com/computergraphics/colorseparations/simulated-process-color-separations-for-screen-printing/
- Adobe on Pantone Color Books: https://helpx.adobe.com/photoshop/kb/pantone-color-books-photoshop.html
- Adobe CEP to UXP migration guide: https://developer.adobe.com/uxp/migration-center/uxp-for-cep-devs/technical-migration-guide/
- Separation Studio NXT / Spot Process: https://solutionsforscreenprinters.com/video-sep-studio-print-over-designed-vector-art-as-spot-process/
- Shirt Board threads (via search summaries): Automated sep software (topic 17310), Separation Studio: worth the $$? (15281), Separation Studio 4 vs SimpleSeps 4 (23391), sim process/moire question (18930)
- Impressions on underbase problems: https://impressionsmagazine.com/process-technique/your-underbase-is-showing/24882/
- Index separation explained: https://www.printablepress.com/index-color-screen-printing-explained/
