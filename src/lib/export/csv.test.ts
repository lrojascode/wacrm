import { describe, expect, it } from 'vitest';

import { toCsv } from './csv';
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';

describe('toCsv — CSV Formula Injection Protection', () => {
  it('prepends single quote to values starting with =, +, -, @, tab, or carriage return', () => {
    const rows = [
      ['phone', 'name', 'company'],
      ['+51999123456', '=SUM(1,2)', '-10'],
      ['@admin', '\tTAB', '\rCR'],
    ];

    const csv = toCsv(rows);

    expect(csv).toContain('"\'+51999123456"');
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"\' -10"'.replace(' ', ''));
    expect(csv).toContain('"\'@admin"');
    expect(csv).toContain('"\'\tTAB"');
  });

  it('escapes internal quotes and quotes fields containing line breaks', () => {
    const rows = [
      ['name', 'notes'],
      ['Jane "CEO" Doe', 'Line 1\nLine 2'],
    ];

    const csv = toCsv(rows);

    expect(csv).toContain('"Jane ""CEO"" Doe"');
    expect(csv).toContain('"Line 1\nLine 2"');
  });

  it('roundtrips cleanly with parseContactCsv so phone numbers survive identically', () => {
    const originalRows = [
      ['phone', 'name', 'email', 'company', 'tags'],
      ['+51999123456', '=1+1', 'test@example.com', 'Acme', 'VIP, Lead'],
    ];

    const csv = toCsv(originalRows);
    const parsed = parseContactCsv(csv);

    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].phone).toBe('+51999123456');
    expect(parsed.rows[0].name).toBe('=1+1');
    expect(parsed.rows[0].email).toBe('test@example.com');
    expect(parsed.rows[0].company).toBe('Acme');
    expect(parsed.rows[0].tagNames).toEqual(['VIP', 'Lead']);
  });
});
