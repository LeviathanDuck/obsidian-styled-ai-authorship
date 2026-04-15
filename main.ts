import { Notice, Plugin } from "obsidian";

export default class LeftcoastAuthorshipPlugin extends Plugin {
  async onload() {
    console.log("Leftcoast Authorship: loaded");
    new Notice("Leftcoast Authorship loaded");
  }

  async onunload() {
    console.log("Leftcoast Authorship: unloaded");
  }
}
