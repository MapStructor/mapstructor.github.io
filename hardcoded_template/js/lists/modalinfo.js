var modal_header_text = [];
var modal_content_html = [];

modal_header_text["about"] = "ABOUT";
modal_content_html["about"] = `
	<p>
		Your map description goes here.
		<br><br>
		Explain what this map shows, how to use it, and who made it.
		<br><br>
		Developed by <a href="https://your-site.com" target="_blank">Your Name</a>.
	</p>
`;

/*
// ─────────────────────────────────────────────
// LAYER INFO MODAL EXAMPLES
// Each layer with an infoId in layersList.js
// needs a matching entry here.
// ─────────────────────────────────────────────

modal_header_text["my-layer-info"] = "My Layer";
modal_content_html["my-layer-info"] = `
	<p>
		Description of this layer — what it shows, where the data comes from,
		known accuracy limitations, and any other relevant notes.
	</p>
`;

modal_header_text["my-group-info"] = "My Group";
modal_content_html["my-group-info"] = `
	<p>
		Description of this group of layers.
	</p>
`;

modal_header_text["section-layer-info"] = "Section Layer";
modal_content_html["section-layer-info"] = `
	<p>
		Description of this layer inside a section.
	</p>
`;

*/
