# Where the art comes from

The `art-*.png` files in `public/` are **AI-generated**. They were made with OpenAI's image generation through the Codex CLI, from prompts asking for original designs, and then reduced by `scripts/office-art.py` to a fixed size and a limited palette. They are not the work of a human artist.

Keep in mind:

- OpenAI's terms give the user the rights in the output, as far as the law allows, and say that similar output may be given to others. These images are not exclusive.
- Purely AI-generated images may not be protected by copyright in some countries, so the MIT licence of this repository may give little or nothing for them. No warranty is given about them, as with the rest of the project.

The code-drawn pixel view (`office-sprites.js`) uses none of them.

`three.module.min.js` is [three.js](https://threejs.org) r170, unmodified, under the MIT licence in `THREE-LICENSE.txt`.

## Regenerating

Generate `floor2.png`, `wall2.png`, `beam.png`, `props.png`, `props2.png`, `props3.png`, `char1.png` to `char6.png` and `seat1.png` to `seat6.png`, then run:

```
python scripts/office-art.py <folder>
```

The character sheets were generated with an earlier generated room image attached as the style reference: cute anime-style people with large heads, about 2.5 to 3 heads tall.

Requirements for the images: original designs with no text or logos; flat, even lighting with no shadows or glow, because the light comes from the engine; a solid pure magenta background for everything except the two tiles; a fixed high three-quarter view. Sheets are 4 columns by 3 rows in the order listed in the script. Character sheets are one row of 6 frames: standing, walking with each foot forward, one hand raised, and two typing frames. Seated sheets show the same characters from the head to the waist, in one row of 4 frames: sitting, two typing frames, and one hand raised.
