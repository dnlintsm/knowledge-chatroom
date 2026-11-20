import type { Locator, Page } from "@playwright/test";

/**
 * Shows the knowledge tree or the experiment list. They open from the place
 * switcher at the top of the Files view, then switch between each other.
 */
export async function showPlaces(
  page: Page,
  view: "Knowledge" | "Experiments" = "Knowledge",
  { tap = false }: { tap?: boolean } = {},
) {
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  const tab = page.getByRole("group", { name: "Place views" }).getByRole("button", { name: view, exact: true });
  if (!(await tab.isVisible())) {
    const files = page.getByRole("button", { name: "Files", exact: true }).first();
    if ((await files.getAttribute("aria-pressed")) !== "true") await press(files);
    await press(page.getByTestId("place-switcher"));
  }
  if ((await tab.getAttribute("aria-pressed")) !== "true") await press(tab);
}
