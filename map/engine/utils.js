/* ── THE COMPANION LIST (8/21) ─────────────────────────────────────────────────────────────
   One logical layer renders as several map layers: the shape itself, its outline, its hover
   highlight, its labels, and — on a folded layer — the overlay holding its edited features.

   Twenty-one places in this codebase enumerate that set, and before today exactly ONE of them
   had it complete (the invariant audit). The rest each kept a different subset, which is how
   `-edited-` ended up being added, refilled and hit-tested but NEVER hidden, removed or
   reordered by anything: deleting a layer left its labels and its edited overlay still drawing,
   with no checkbox able to turn them off, until a reload.

   This is the one list. Consumers read it and fall back to their own historical subset, so a
   load-order surprise degrades to the old behaviour instead of breaking. utils.js is the right
   home: it loads before every other engine file and already owns flatLayers, the one tree-walk.  */
var MS_COMPANIONS = ["-stroke-", "-highlighted-", "-label-", "-edited-"];

// every map-layer id one logical layer owns, both swipe sides. Base ids first.
function msLayerVariants(slug) {
  const out = [slug + "-left", slug + "-right"];
  MS_COMPANIONS.forEach((sfx) => out.push(slug + sfx + "left", slug + sfx + "right"));
  return out;
}

/* ── THE DATE RULE (8/21) ──────────────────────────────────────────────────────────────────
   "Visible at day D" was written out by hand in four places, and they DISAGREE — deliberately in
   one case and accidentally in the others:

     shapes  ["all", ["<=", "DayStart", d], [">=", "DayEnd", d]]
             legacy syntax; a feature with no Day props is HIDDEN.
     labels  the same, wrapped in coalesce so a MISSING property means "always visible".
             Group and point anchors carry no Day props at all, so without the coalesce every
             anchor label on the map disappears the moment the slider moves.

   The accident is that three sites in editing.js — the timeline-ignore toggle, the re-source
   path and the sidebar visibility sweep — applied the SHAPE filter to shapes, strokes and
   highlights and simply never touched labels, while their comment claimed "companions included".
   Turning on "show everything" left the labels still date-filtered: every shape appeared and its
   label did not.

   One author for the rule, two kinds. Pass the kind; never write the expression again.       */
function msDateFilter(kind, day, timelineIgnore) {
  if (timelineIgnore || day == null) return null;
  return kind === "label"
    ? ["all", ["<=", ["coalesce", ["get", "DayStart"], 0], day],
              [">=", ["coalesce", ["get", "DayEnd"], 99999999], day]]
    : ["all", ["<=", "DayStart", day], [">=", "DayEnd", day]];
}

/* Which date rule does this map-layer id follow? Derived from the id rather than remembered at
   each call site — the same reason the companion list lives here. */
function msDateKindFor(layerId) {
  return /-label-|-labels-/.test(String(layerId)) ? "label" : "shape";
}

function flatLayers(nodes) {
  const result = [];
  nodes.forEach(node => {
    if (node.children) {
      result.push(...flatLayers(node.children));
    } else {
      result.push(node);
    }
  });
  return result;
}

function findLayer(nodes, label) {
  for (const node of nodes) {
    if (node.label === label) return node;
    if (node.children) {
      const found = findLayer(node.children, label);
      if (found) return found;
    }
  }
  return null;
}

function simple_tooltip(target_items, name) {
    $(target_items).each(function (i) {
      $("body").append(
        "<div class='" +
          name +
          "' id='" +
          name +
          i +
          "'><p>" +
          $(this).attr("title") +
          "</p></div>"
      );
      var my_tooltip = $("#" + name + i);
  
      $(this)
        .removeAttr("title")
        .mouseover(function () {
          my_tooltip.css({ opacity: 1.0, display: "none" }).fadeIn(200);
        })
        .mousemove(function (kmouse) {
          my_tooltip.css({
            left: kmouse.pageX + 15,
            top: kmouse.pageY + 15,
          });
        })
        .mouseout(function () {
          my_tooltip.fadeOut(200);
        });
    });
  }


// Function to calculate the
// length of an array
function sizeOfArray(array) {
    // A variable to store
    // the size of arrays
    let size = 0;
  
    // Traversing the array
    for (let key in array) {
      // Checking if key is present
      // in arrays or not
      if (array.hasOwnProperty(key)) {
        size++;
      }
    }
  
    // Return the size
    return size;
  };
  
  function itemsCompressExpand(items_class, caret_id) {
    if ($(caret_id).hasClass("fa-minus-square")) {
      $(caret_id).removeClass("fa-minus-square").addClass("fa-plus-square");
      $(items_class).hide();
    } else if ($(caret_id).hasClass("fa-plus-square")) {
      $(caret_id).removeClass("fa-plus-square").addClass("fa-minus-square");
      $(items_class).show();
    }
  }
  
  function sectionCompressExpand(section_id, caret_id) {
    if ($(caret_id).hasClass("fa-minus-square")) {
      $(caret_id).removeClass("fa-minus-square").addClass("fa-plus-square");
      $(section_id).slideUp();
    } else if ($(caret_id).hasClass("fa-plus-square")) {
      $(caret_id).removeClass("fa-plus-square").addClass("fa-minus-square");
      $(section_id).slideDown();
    }
  }
  