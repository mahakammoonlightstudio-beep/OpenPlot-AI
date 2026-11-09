import { useData, createProjectUi } from '../store';
import { useT } from '../i18nReact';
import { textPrompt } from './TextPrompt';
import { Icon } from './Icons';

/**
 * Project switcher for the Story section (Story Bible, Chapters).
 *
 * "New project" used to sit in the sidebar next to New chat / New folder, where
 * it read as a chat action. Creating a project is a writing action, so it lives
 * with the writing views here; the sidebar keeps New chat and New folder (and
 * the Ctrl+Shift+N shortcut / palette command still work anywhere).
 */
export function ProjectPickerBar() {
  const t = useT();
  const projects = useData((s) => s.projects);
  const activeProjectId = useData((s) => s.activeProjectId);
  const setActiveProject = useData((s) => s.setActiveProject);

  async function create() {
    const name = await textPrompt({ title: t('projects.name'), confirmLabel: t('projects.create') });
    if (!name || !name.trim()) return;
    await createProjectUi(name.trim());
  }

  return (
    <div className="project-bar">
      <Icon name="folder" size={13} />
      <select
        value={activeProjectId || ''}
        aria-label={t('app.projects')}
        onChange={(e) => setActiveProject(e.target.value || null)}
      >
        {projects.length === 0 && <option value="">{t('projects.empty')}</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button
        className="small primary"
        onClick={create}
        title={t('app.newProject')}
        aria-label={t('app.newProject')}
      >
        <Icon name="plus" size={13} /> {t('app.newProject')}
      </button>
    </div>
  );
}
