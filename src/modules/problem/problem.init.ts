import { problemService } from "@/modules/problem/problem.service.js";

export default async function () {
  await problemService.init();
}
