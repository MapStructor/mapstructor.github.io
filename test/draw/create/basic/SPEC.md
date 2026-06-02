# Draw System — Spec & Test Checklist

## How It Works

### Layers

- Layers are created manually via "Add Layer" (name only, no type)
- A new layer starts typeless — it has no geometry type until the first feature is drawn into it
- The first feature drawn into a typeless layer assigns its geometry type permanently
- After a type is assigned, a layer only accepts features of that type
- A newly created layer is always set as the active (highlighted) layer

### Drawing Features

When a feature is drawn, the following logic runs in order:

1. **Active layer is typeless** → assign the drawn geometry type to it, add the feature
2. **Active layer already matches the drawn type** → add the feature
3. **Active layer is a different type** → check if any layer of the drawn type exists
   - No layer of that type exists anywhere → auto-create a new layer of that type, add the feature
   - A layer of that type already exists → reject with a prominent error, do not add the feature
4. **No layer is highlighted** → reject with a prominent error, do not add the feature

### Auto-Create

- If there are no layers at all and a feature is drawn, a layer is automatically created for that geometry type
- This is the only case where a layer is created without a name prompt

### Project Persistence

- On page load with no `?id=` in the URL, a new project is immediately created in Supabase and `?id=` is set in the URL
- Every map has a permanent URL from the moment it opens
- Changes are autosaved 1 second after the last action — no Save button
- Autosave triggers on: feature drawn, feature deleted, geometry edited, label changed, notes changed
- Saving updates the existing project row (never creates a duplicate)
- Loading reads from `?id=` on page load if present

---

## Test Checklist

Run through this after any change to `create.js`.

### Layers

- [ ] "Add Layer" asks for a name only (no type prompt)
- [ ] New layer appears in the sidebar highlighted/active
- [ ] New layer shows no type indicator (typeless)

### Drawing — Happy Path

- [ ] Draw a point with no layers → auto-creates a Point layer, feature is added
- [ ] Draw a line with no layers → auto-creates a Line layer, feature is added
- [ ] Draw a polygon with no layers → auto-creates a Polygon layer, feature is added
- [ ] Draw a second feature of the same type → added to the same layer
- [ ] Draw a third, fourth feature of the same type → all added correctly
- [ ] Add a layer manually, draw a point into it → layer claims Point type, feature is added
- [ ] Add a second feature to that same layer → added correctly

### Drawing — Type Enforcement

- [ ] Highlight a Point layer, draw a line → prominent error toast appears, line is NOT added to map
- [ ] Highlight a Line layer, draw a polygon → prominent error toast appears, polygon is NOT added
- [ ] After rejection, the correct feature count in the sidebar is unchanged

### Drawing — Auto-Create for New Type

- [ ] Have a Point layer active, draw a line → no Line layer exists → Line layer is auto-created, feature added
- [ ] Have a Point layer active, draw a polygon → no Polygon layer exists → Polygon layer is auto-created, feature added
- [ ] Now have Point, Line, and Polygon layers → highlight Point layer, draw a line → Line layer already exists → rejected with toast

### Drawing — No Active Layer

- [ ] Deselect all layers (click active layer to deselect if possible), draw a feature → rejected with error toast

### Feature Panel

- [ ] Drawing a feature opens the feature panel on the right
- [ ] Panel shows the correct layer name
- [ ] Label field saves on input
- [ ] Notes field saves on input
- [ ] Clicking ✕ closes the panel
- [ ] Clicking another feature opens the panel for that feature
- [ ] Clicking the map (no feature) closes the panel

### Delete

- [ ] Delete button in feature panel removes the feature from the map
- [ ] Feature count in sidebar updates
- [ ] Feature panel closes after delete

### Visibility Toggle

- [ ] Unchecking a layer checkbox hides all features in that layer
- [ ] Re-checking restores them

### Autosave & Load

- [ ] Page load with no `?id=` → URL updates immediately with `?id=`
- [ ] Draw a feature → 1 second later a save occurs (reload to verify)
- [ ] Edit a label or notes → triggers autosave
- [ ] Delete a feature → triggers autosave
- [ ] Reload the page with `?id=` in URL → all layers and features restored correctly
- [ ] Copy URL, open in new tab → same map loads
- [ ] Project name is editable and persists after autosave/reload
