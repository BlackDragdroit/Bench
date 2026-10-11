// Zugriffsregeln. Der Besitzer darf alles. Ein Gast (über einen Einladungslink) darf
// genau ein Projekt bearbeiten, dessen Skizzen und Dateien, und die Teilebibliothek lesen.
// Reine Funktionen ohne Datenbank, damit jede Regel einzeln getestet werden kann.

export const forbidden = (why = 'forbidden') => Object.assign(new Error(why), { status: 403, code: 'forbidden' });
const isGuest = a => a && a.kind === 'guest';

// Welche Einträge einer Sammlung darf der Akteur sehen?
// Gibt einen Filter für die Liste zurück: { where } für die Datenbank und/oder { keep(doc) }.
export function listScope(actor, coll, where) {
  if (!isGuest(actor)) return { where };
  switch (coll) {
    case 'projects': return { where, keep: d => d.id === actor.projectId };
    case 'parts': return { where };
    case 'sketches':
      if (where && !(where.field === 'projectId' && where.value === actor.projectId)) throw forbidden('sketches of another project');
      return { where: { field: 'projectId', value: actor.projectId } };
    default: throw forbidden(`no access to ${coll}`);
  }
}

export function canRead(actor, coll, id, data) {
  if (!isGuest(actor)) return true;
  switch (coll) {
    case 'projects': return id === actor.projectId;
    case 'parts': return true;
    case 'sketches': return !!data && data.projectId === actor.projectId;
    default: return false;
  }
}

// Schreibzugriff prüfen. method: 'set' | 'update' | 'delete'. old: bisheriger Inhalt oder null.
export function checkWrite(actor, coll, id, method, old, body) {
  if (!isGuest(actor)) return;
  const P = actor.projectId;
  switch (coll) {
    case 'projects':
      if (id !== P) throw forbidden('another project');
      if (method !== 'update') throw forbidden('guests can only change the project, not create or delete it');
      return;
    case 'sketches':
      if (old && old.projectId !== P) throw forbidden('sketch of another project');
      if (method === 'set' && (!body || body.projectId !== P)) throw forbidden('sketch must belong to the shared project');
      if (method === 'update' && (!old || (body && 'projectId' in body && body.projectId !== P))) throw forbidden('sketch must stay in the shared project');
      if (method === 'delete' && !old) throw forbidden('unknown sketch');
      return;
    case 'parts': throw forbidden('guests can’t change the parts library');
    default: throw forbidden(`no access to ${coll}`);
  }
}

// Dateien: ein Gast sieht und löscht nur Dateien seines Projekts oder solche, die er selbst hochgeladen hat
export function canUseAsset(actor, asset, project) {
  if (!isGuest(actor)) return true;
  if (!asset) return false;
  if (asset.invite_id && asset.invite_id === actor.inviteId) return true;
  return !!(project && Array.isArray(project.files) && project.files.some(f => f && f.assetId === asset.id));
}

// Funktionen, die nur der Besitzer nutzen darf oder die Kosten verursachen
export function checkFeature(actor, feature) {
  if (!isGuest(actor)) return;
  if (feature === 'ai' && actor.allowAi) return;
  throw forbidden(`${feature} is not available for guests`);
}

// Änderungsmeldungen (Live-Updates): nur für Dinge, die der Gast auch lesen darf
export function canSeeEvent(actor, ev) {
  if (!isGuest(actor)) return true;
  if (ev.c === 'projects') return ev.id === actor.projectId;
  if (ev.c === 'parts') return true;
  if (ev.c === 'sketches' || ev.c === 'presence') return !!ev.projectId && ev.projectId === actor.projectId;
  return false;
}
