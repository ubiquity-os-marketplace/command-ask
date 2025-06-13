import { drive_v3 } from "googleapis";
import { Context } from "../../../types";

export class SuperGoogle {
  protected client: drive_v3.Drive;
  protected context: Context;
  constructor(client: drive_v3.Drive, context: Context) {
    this.client = client;
    this.context = context;
  }
}
