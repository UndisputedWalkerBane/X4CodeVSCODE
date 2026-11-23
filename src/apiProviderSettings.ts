import * as vscode from "vscode";
import type { ApiProviderProfileStore, ApiProviderProfileSummary } from "./apiProviderProfiles";

/** Native inputs keep provider credentials out of the webview and remote clients. */
export async function manageApiProviderSettings(store: ApiProviderProfileStore): Promise<void> {
  const profiles = await store.list();
  const pick = await vscode.window.showQuickPick([
    ...profiles.map(profile => ({ label: profile.name, description: profile.model,
      detail: profile.baseUrl + (profile.hasApiKey ? " · ключ сохранён" : " · без ключа"), profile })),
    { label: "$(add) Добавить API-провайдера", profile: undefined },
  ], { title: "API-провайдеры", placeHolder: "Агент работает с файлами и доступами проекта в режиме разрешений Codex.", ignoreFocusOut: true });
  if (!pick) return;
  const profile: ApiProviderProfileSummary | undefined = pick.profile;
  if (profile) {
    const actions = [{ label: "Изменить настройки", action: "edit" }];
    if (profile.hasApiKey) actions.push({ label: "Удалить сохранённый ключ", action: "clear" });
    if (!profile.builtIn) actions.push({ label: "Удалить провайдера", action: "remove" });
    const choice = await vscode.window.showQuickPick(actions, { title: profile.name, ignoreFocusOut: true });
    if (!choice) return;
    if (choice.action !== "edit") {
      if (await vscode.window.showWarningMessage(choice.label + " — " + profile.name + "?", { modal: true }, "Удалить") !== "Удалить") return;
      if (choice.action === "clear") await store.clearApiKey(profile.id);
      else await store.remove(profile.id);
      return;
    }
  }
  const field = (title: string, value = "", placeHolder?: string) =>
    vscode.window.showInputBox({ title, value, placeHolder, ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : "Заполните поле." });
  const name = profile?.builtIn ? profile.name : await field("Название API-провайдера", profile?.name);
  if (name === undefined) return;
  const baseUrl = profile?.builtIn ? profile.baseUrl : await field("Базовый адрес Responses API", profile?.baseUrl, "https://example.com/v1");
  if (baseUrl === undefined) return;
  const model = profile?.builtIn ? profile.model : await field("Идентификатор модели", profile?.model);
  if (model === undefined) return;
  const apiKey = await vscode.window.showInputBox({ title: "API-ключ · " + name, password: true, ignoreFocusOut: true,
    prompt: profile?.hasApiKey && baseUrl === profile.baseUrl ? "Оставьте пустым, чтобы сохранить действующий ключ." : "Введите ключ этого сервера. Для локального сервера без авторизации оставьте пустым." });
  if (apiKey === undefined) return;
  await store.save({ id: profile?.id, name, baseUrl, model, apiKey: apiKey || undefined });
  void vscode.window.showInformationMessage("API-провайдер сохранён.");
}
