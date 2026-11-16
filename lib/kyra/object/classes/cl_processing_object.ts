// Optional helper to enforce the AS4TAB 30-character max length
type TabName = string;

abstract class cl_processing_object {
  public static potype_source = "S";
  public static potype_target = "T";

  public abstract read(): void;
  public abstract write(): void;

  //Protected section
  protected md_data: unknown;
  protected mv_filter: boolean;

  //Private section
  private mv_structure_read: TabName;
  private mv_structure_write: TabName;
  public constructor(
    iv_structure_read: TabName,
    iv_structure_write: TabName,
    iv_filter: boolean,
  ) {
    this.mv_structure_read = iv_structure_read;
    this.mv_structure_write = iv_structure_write;
    this.mv_filter = iv_filter;

  }
}
