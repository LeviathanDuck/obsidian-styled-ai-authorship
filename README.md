# Leftcoast Authorship

An Obsidian plugin that replicates iA Writer's "paste as AI author" feature: text pasted via the plugin's command is visually marked with a colored gradient, tracked per-character, and persists across sessions and devices.

## Status

Under active development. Spec lives at `../1.Orthanc/workshop/leftcoast-authorship-plugin/`.

## Development

```sh
npm install
npm run dev      # watches main.ts and rebuilds main.js
npm run build    # production build (minified, no sourcemaps)
```

### Dev vault setup

```sh
# Create a dev vault (first time only)
mkdir -p ~/Development/leftcoast-authorship-devvault/.obsidian/plugins
ln -s ~/Development/leftcoast-authorship ~/Development/leftcoast-authorship-devvault/.obsidian/plugins/leftcoast-authorship
```

Open the dev vault in Obsidian, enable Community Plugins (disable Safe Mode), then enable "Leftcoast Authorship."

## License

MIT
