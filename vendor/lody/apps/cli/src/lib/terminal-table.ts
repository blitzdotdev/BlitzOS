import Table from 'cli-table3';

type TableColumn = {
  header: string;
  align?: 'left' | 'center' | 'right';
};

function formatTableCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }

  const text = String(value);
  return text.trim() ? text : '-';
}

export function renderTerminalTable(columns: TableColumn[], rows: unknown[][]): string {
  const table = new Table({
    head: columns.map((column) => column.header),
    colAligns: columns.map((column) => column.align ?? 'left'),
    style: {
      head: [],
      border: [],
    },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push(row.map((cell) => formatTableCell(cell)));
  }

  return table.toString();
}
