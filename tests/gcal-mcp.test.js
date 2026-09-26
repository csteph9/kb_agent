import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Google Calendar MCP server advertises bounded read and write tools', async () => {
  const client = new Client({ name: 'gcal-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('gcal-mcp.js')],
    cwd: process.cwd(),
    stderr: 'pipe'
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map(tool => tool.name).sort(),
      [
        'gcal_create_event',
        'gcal_delete_event',
        'gcal_get_event',
        'gcal_list_calendars',
        'gcal_list_events',
        'gcal_list_sources',
        'gcal_update_event'
      ]
    );
    const create = result.tools.find(tool => tool.name === 'gcal_create_event');
    assert.equal(create.annotations.readOnlyHint, false);
    assert.equal(create.annotations.idempotentHint, true);
  } finally {
    await client.close();
  }
});

test('Telegram calendar turns require the MCP server and pre-approve its tools', async () => {
  const wrapper = await fs.readFile('run-codex.sh', 'utf8');
  assert.match(wrapper, /mcp_servers\.knowledge-gcal\.required=true/);
  assert.match(
    wrapper,
    /mcp_servers\.knowledge-gcal\.default_tools_approval_mode="approve"/
  );
});
