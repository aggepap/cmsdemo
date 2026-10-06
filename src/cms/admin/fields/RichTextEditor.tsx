'use client';

import Link from '@tiptap/extension-link';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { type Editor, EditorContent, type JSONContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useState } from 'react';

import { shortcodeList } from '../../core/shortcodes';
import { InsertShortcodeDialog } from './InsertShortcodeDialog';

/**
 * TipTap rich-text editor. Stores content as TipTap JSON (not HTML strings —
 * fixing v1's lossy serialized-JSX approach, BACKEND.md §13.7). `immediatelyRender:
 * false` avoids SSR hydration mismatches in the Next app router.
 */
const EMPTY_DOC: JSONContent = { type: 'doc', content: [] };

/**
 * The toolbar's buttons.
 *
 * Their faces are "B", "i", "H2", "❝" — fine to look at, useless to a screen
 * reader and a puzzle to anyone who has not used a word processor. Each one now
 * has a spoken name (`label`) and a hover line (`title`) saying what it does and
 * its keyboard shortcut (TipTap's StarterKit defaults).
 */
export interface RichTextTool {
  id: string;
  face: string;
  label: string;
  title: string;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

export const RICH_TEXT_TOOLS: readonly RichTextTool[] = [
  {
    id: 'bold',
    face: 'B',
    label: 'Bold',
    title: 'Bold (Ctrl/Cmd+B)',
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    face: 'i',
    label: 'Italic',
    title: 'Italic (Ctrl/Cmd+I)',
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: 'h2',
    face: 'H2',
    label: 'Heading 2',
    title: 'Section heading. Use it to split the text into sections (Ctrl/Cmd+Alt+2)',
    isActive: (e) => e.isActive('heading', { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    face: 'H3',
    label: 'Heading 3',
    title: 'Smaller heading, for a part inside a section (Ctrl/Cmd+Alt+3)',
    isActive: (e) => e.isActive('heading', { level: 3 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bulletList',
    face: '• List',
    label: 'Bulleted list',
    title: 'Bulleted list (Ctrl/Cmd+Shift+8)',
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    face: '1. List',
    label: 'Numbered list',
    title: 'Numbered list (Ctrl/Cmd+Shift+7)',
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'blockquote',
    face: '❝',
    label: 'Quote',
    title: 'Quote: sets the paragraph apart as a quotation (Ctrl/Cmd+Shift+B)',
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'link',
    face: 'Link',
    label: 'Link',
    title: 'Link the selected text to a web address. Clear the address to remove the link.',
    isActive: (e) => e.isActive('link'),
    run: (e) => {
      const prev = e.getAttributes('link').href as string | undefined;
      const url = window.prompt('Link URL', prev ?? 'https://');
      if (url === null) return;
      if (url === '') e.chain().focus().unsetLink().run();
      else e.chain().focus().setLink({ href: url }).run();
    },
  },
  {
    id: 'table',
    face: '⊞ Table',
    label: 'Insert table',
    title: 'Insert a table of 3 rows and 3 columns, the first row as headings',
    isActive: (e) => e.isActive('table'),
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
];

/**
 * Row and column controls, shown only while the cursor is inside a table — they
 * do nothing anywhere else, and five dead buttons would crowd the toolbar.
 */
export const TABLE_TOOLS: readonly RichTextTool[] = [
  {
    id: 'addRowAfter',
    face: '+ Row',
    label: 'Add row below',
    title: 'Add a row below the current one',
    isActive: () => false,
    run: (e) => e.chain().focus().addRowAfter().run(),
  },
  {
    id: 'addColumnAfter',
    face: '+ Column',
    label: 'Add column right',
    title: 'Add a column to the right of the current one',
    isActive: () => false,
    run: (e) => e.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'deleteRow',
    face: '− Row',
    label: 'Delete row',
    title: 'Delete the current row',
    isActive: () => false,
    run: (e) => e.chain().focus().deleteRow().run(),
  },
  {
    id: 'deleteColumn',
    face: '− Column',
    label: 'Delete column',
    title: 'Delete the current column',
    isActive: () => false,
    run: (e) => e.chain().focus().deleteColumn().run(),
  },
  {
    id: 'deleteTable',
    face: '✕ Table',
    label: 'Delete table',
    title: 'Delete the whole table',
    isActive: () => false,
    run: (e) => e.chain().focus().deleteTable().run(),
  },
];

/**
 * Every node type the editor knows. Tables are here because seeded pages carry
 * them: TipTap drops a node its schema does not know, so without these, opening
 * such a page and saving it deleted the table (F-002).
 */
const EXTENSIONS = [StarterKit, Link.configure({ openOnClick: false }), Table, TableRow, TableHeader, TableCell];

const toolClass = (active: boolean) =>
  `px-2 py-1 text-xs rounded ${active ? 'bg-neutral-800 text-white' : 'bg-neutral-100 hover:bg-neutral-200'}`;

/**
 * The button row, apart from the editor so its names can be checked without a
 * browser (the editor itself only exists client-side).
 */
export function RichTextToolbar({
  isActive,
  inTable = false,
  onTool,
  onInsertBlock,
}: {
  isActive: (id: string) => boolean;
  /** Whether the cursor is in a table, which shows the row and column controls. */
  inTable?: boolean;
  onTool: (id: string) => void;
  onInsertBlock: () => void;
}) {
  const tools = inTable ? [...RICH_TEXT_TOOLS, ...TABLE_TOOLS] : RICH_TEXT_TOOLS;
  return (
    <div className="flex flex-wrap gap-1 border-b border-neutral-200 p-1.5">
      {tools.map((tool) => {
        const active = isActive(tool.id);
        return (
          <button
            key={tool.id}
            type="button"
            aria-label={tool.label}
            title={tool.title}
            aria-pressed={active}
            className={toolClass(active)}
            onClick={() => onTool(tool.id)}
          >
            <span aria-hidden="true">{tool.face}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label="Insert block"
        title="Insert reviews, a form, a countdown…"
        className={toolClass(false)}
        onClick={onInsertBlock}
      >
        <span aria-hidden="true">+ Block</span>
      </button>
    </div>
  );
}

export function RichTextEditor({
  value,
  onChange,
  moduleFlags,
}: {
  value: JSONContent | null | undefined;
  onChange: (value: JSONContent) => void;
  /**
   * Which modules are on, so the insert dialog can say why a block is not
   * available rather than hiding it. Normally omitted: the dialog reads the
   * admin shell's `ModuleFlagsProvider`. Pass a map only to override it.
   */
  moduleFlags?: Readonly<Record<string, boolean>>;
}) {
  const [inserting, setInserting] = useState(false);
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: value ?? EMPTY_DOC,
    immediatelyRender: false,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none min-h-[160px] focus:outline-none px-3 py-2',
      },
    },
  });

  // The editor does not re-render on a selection change, so whether the cursor
  // is in a table is subscribed to: the row and column controls follow it.
  const inTable = useEditorState({ editor, selector: ({ editor: e }) => e?.isActive('table') ?? false }) ?? false;

  // `useEditor` seeds `content` once on mount, so switching locale tabs (which
  // feeds a new `value`) would otherwise leave the previous language's content
  // in the editor — and save it back to the wrong locale. Re-sync when `value`
  // changes externally; the equality guard leaves the cursor alone while typing
  // (during typing `value` already equals the editor's JSON via onUpdate).
  useEffect(() => {
    if (!editor) return;
    const incoming = value ?? EMPTY_DOC;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(incoming)) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) {
    return <div className="min-h-[200px] rounded-md border border-neutral-300 bg-neutral-50" />;
  }

  return (
    <div className="rounded-md border border-neutral-300 bg-white">
      <RichTextToolbar
        isActive={(id) => {
          const tool = RICH_TEXT_TOOLS.find((t) => t.id === id);
          return tool ? tool.isActive(editor) : false;
        }}
        inTable={inTable}
        onTool={(id) => [...RICH_TEXT_TOOLS, ...TABLE_TOOLS].find((t) => t.id === id)?.run(editor)}
        onInsertBlock={() => setInserting(true)}
      />
      {inserting ? (
        <div className="border-b border-neutral-200 bg-neutral-50 p-3">
          <InsertShortcodeDialog
            shortcodes={shortcodeList()}
            moduleFlags={moduleFlags}
            onClose={() => setInserting(false)}
            onInsert={(text) => {
              /*
               * Inserted as its own paragraph, which is exactly what the
               * renderer looks for — a shortcode sharing a line with prose is
               * left as prose on purpose.
               */
              editor.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text }] }).run();
              setInserting(false);
            }}
          />
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}
