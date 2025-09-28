import { Plugin } from 'obsidian';
import { virtualCursorExtension } from './plugin';

export default class VirtualCursorPlugin extends Plugin {
	async onload() {
		this.registerEditorExtension(virtualCursorExtension);
	}
}
