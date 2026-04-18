# Ai Styled Text Authorship For Obsidian

An Obsidian plugin that replicates iA Writer's "paste as AI author" feature: text pasted via the plugin's command is visually marked with a colored gradient, tracked per-character, and persists across sessions and devices.

![AiStyled-Authorship Plugin Examples](assets/AiAuthorship%20Plugin%20Examples.png)

## Inspired by iA Writer

This plugin exists of my love for [iA Writer](https://ia.net/writer) and its Authorship feature. iA Writer and the team behind it deserves all the credit in the world. 

If you haven't tried iA Writer, I'd encourage you to. 

This plugin is an independent implementation and has no affiliation of any kind. No iA Writer code is used. 

## Status

Under active development. 

## Development

```sh
npm install
npm run dev      # watches main.ts and rebuilds main.js
npm run build    # production build (minified, no sourcemaps)
```

### Install into an Obsidian vault

Either symlink the plugin folder into a vault's `.obsidian/plugins/` directory, or copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/aistyled-authorship/` after a build. Then enable Community Plugins in Obsidian and turn on **AiStyled-Authorship**.

## Disclaimer

> **Use at your own risk.** This plugin reads and writes files in your vault. 

Back up your data. The author accepts no liability for data loss, corruption, or any other issues arising from its use. See [LICENSE](./LICENSE) for full terms.

## Trademarks


## License

*A project of the Leviathan Duck from Leftcoast Media House Inc.*

MIT. Copyright © 2026 Leftcoast Media House Inc.

---

## Author

<p align="center">
  <a href="https://github.com/LeviathanDuck">
    <img src="./assets/LeviathanDuck.png" width="100" alt="LeviathanDuck" style="border-radius:50%" />
  </a>
</p>

<p align="center">
  Built by <a href="https://github.com/LeviathanDuck">Leviathan Duck</a> — Leftcoast Media House Inc.<br/>
  Licensed under <a href="./LICENSE">MIT</a>.<br/>
  <a href="https://github.com/LeviathanDuck?tab=repositories">More Obsidian plugins &amp; themes</a>
</p>
