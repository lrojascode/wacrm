/**
 * PostgREST corta en `max_rows` (1000, supabase/config.toml) sin avisar:
 * devuelve 200 con la página recortada y ningún error. En una exportación
 * eso produce un archivo truncado que parece completo, así que toda
 * lectura de exportación tiene que pasar por aquí.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const result: T[] = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) {
      throw error;
    }
    if (!data || data.length === 0) {
      break;
    }
    result.push(...data);
    if (data.length < pageSize) {
      hasMore = false;
    } else {
      from += pageSize;
    }
  }

  return result;
}
