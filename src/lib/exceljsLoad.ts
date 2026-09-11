/**
 * exceljs 是 CJS 包，vite 预构建（esbuild）只生成 `export default`、检测不出命名导出，
 * `const { Workbook } = await import('exceljs')` 在运行期拿到 undefined。
 * 统一从这里取 Workbook 构造器：优先命名导出，回退 default.Workbook。
 */
export async function loadExcelWorkbook(): Promise<typeof import('exceljs').Workbook> {
  const mod = (await import('exceljs')) as unknown as {
    Workbook?: typeof import('exceljs').Workbook
    default?: { Workbook?: typeof import('exceljs').Workbook }
  }
  const Ctor = mod.Workbook ?? mod.default?.Workbook
  if (!Ctor) throw new Error('exceljs 模块加载异常（未找到 Workbook）')
  return Ctor
}
