export interface StoryTemplateField { label: string; ph: string }
export interface StoryTemplate {
  sections: string[];
  fields: Record<string, StoryTemplateField>;
}

export const STORY_TEMPLATES: Record<string, StoryTemplate> = {
  world: {
    sections: ['Overview', 'Geography', 'Cultures & Factions', 'Magic / Technology', 'History', 'Conflicts'],
    fields: {
      name: { label: 'World name', ph: 'e.g. Aetheria' },
      era: { label: 'Era / time period', ph: 'e.g. The Third Age' },
      tone: { label: 'Tone & atmosphere', ph: 'e.g. grim, hopeful, mythic…' }
    }
  },
  location: {
    sections: ['Overview', 'Appearance', 'Inhabitants', 'Secrets & Dangers', 'Connections'],
    fields: {
      name: { label: 'Location name', ph: 'e.g. The Sunken Market' },
      region: { label: 'Region / world', ph: 'e.g. Northern Aetheria' },
      purpose: { label: 'What happens here', ph: 'e.g. black-market trade, ambushes…' }
    }
  },
  character: {
    sections: ['Summary', 'Appearance', 'Personality', 'Motivation & Goal', 'Fears & Flaws', 'Arc', 'Relationships', 'Voice Notes'],
    fields: {
      name: { label: 'Character name', ph: 'e.g. Kael Ardent' },
      role: { label: 'Role in story', ph: 'e.g. protagonist, rival, mentor' },
      age: { label: 'Age', ph: 'e.g. 27' }
    }
  },
  item: {
    sections: ['Overview', 'Description', 'Powers & Rules', 'History', 'Current Owner / Whereabouts'],
    fields: {
      name: { label: 'Item name', ph: 'e.g. The Hollow Crown' },
      type: { label: 'Type', ph: 'e.g. weapon, artifact, trinket' },
      significance: { label: 'Why it matters', ph: 'e.g. key to the final act' }
    }
  },
  lore: {
    sections: ['Summary', 'The Legend', 'The Truth', 'Implications for the Plot', 'Sources & Rumors'],
    fields: {
      title: { label: 'Lore title', ph: 'e.g. The Vanishing of the Ninth Fleet' },
      origin: { label: 'Origin / who tells it', ph: 'e.g. sailors of the coast' }
    }
  }
};

export function renderTemplate(templateId: string, values: Record<string, string>): string {
  const tpl = STORY_TEMPLATES[templateId];
  if (!tpl) return '';
  const lines: string[] = [];
  const meta = Object.entries(tpl.fields)
    .map(([k, f]) => `- ${f.label}: ${values[k] || '—'}`)
    .join('\n');
  if (meta) lines.push(meta, '');
  for (const s of tpl.sections) lines.push(`## ${s}\n`);
  return lines.join('\n').trim() + '\n';
}
