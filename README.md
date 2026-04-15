# Ai Styled Text Authorship For Obsidian. 

An Obsidian plugin that replicates iA Writer's "paste as AI author" feature: text pasted via the plugin's command is visually marked with a colored gradient, tracked per-character, and persists across sessions and devices.

*A project of the Leviathan Duck from Leftcoast Media House Inc.*

## Status

Under active development. Spec lives at `../../1.Orthanc/workshop/plugins/leftcoast-authorship-plugin/`.

## Development

```sh
npm install
npm run dev      # watches main.ts and rebuilds main.js
npm run build    # production build (minified, no sourcemaps)
```

### Install into an Obsidian vault

Either symlink the plugin folder into a vault's `.obsidian/plugins/` directory, or copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/leftcoast-authorship/` after a build. Then enable Community Plugins in Obsidian and turn on **Leftcoast Authorship**.

## Credits

Inspired by [iA Writer](https://ia.net/writer)'s Authorship feature. Independent implementation; no iA Writer code is used.

## License

MIT. Copyright © 2026 Leftcoast Media House Inc.
