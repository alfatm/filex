/**
 * Every tool the server declares (`assistantTools.Specs`), in that order.
 *
 * The panel says what the assistant is doing in the person's language, and it can only do that for a name it has
 * words for. Nine of these were missing, so a plan the person was about to approve announced itself as
 * "plan_empty_trash main://…". The list lives here rather than inside the panel so a test can hold it against the
 * three locale files: a name added on the server has to be added here and translated before it can be shown.
 */
export const ASSISTANT_TOOLS = [
  'list_storages',
  'list_folder',
  'search_files',
  'list_versions',
  'list_shares',
  'list_trash',
  'plan_tags',
  'plan_restore_version',
  'plan_create_share',
  'plan_revoke_share',
  'plan_move',
  'plan_empty_trash',
  'read_file',
  'read_image_text',
  'view_image',
  'write_report',
] as const;
