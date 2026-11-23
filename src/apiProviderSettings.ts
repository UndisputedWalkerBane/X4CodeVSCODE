import * as vscode from "vscode";
import { ABLITERATION_MODELS, apiEffortLevels, isValidApiModelId } from "./apiModelParameters";
import type { ApiProviderProfileStore, ApiProviderProfileSummary } from "./apiProviderProfiles";

async function chooseDefaults(profile?: ApiProviderProfileSummary): Promise<{ model: string; effort?: string } | undefined> {
  let model: string | undefined;
  if (profile?.builtIn) {
    const models = [...new Set([profile.model, ...ABLITERATION_MODELS])];
    const choice = await vscode.window.showQuickPick([
      ...models.map(value => ({ label: value, value, description: value === profile.model ? "Текущая модель" : undefined })),
      { label: "Ввести идентификатор модели…", value: "" },
    ], { title: "Модель по умолчанию · " + profile.name, ignoreFocusOut: true });
    if (!choice) return;
    model = choice.value;
  }
  if (!model) {
    const input = await vscode.window.showInputBox({
      title: "Идентификатор модели по умолчанию", value: profile?.model ?? "", ignoreFocusOut: true,
      validateInput: v => v === profile?.model || isValidApiModelId(v.trim()) ? undefined : "Введите идентификатор модели.",
    });
    if (input === undefined) return;
    model = input.trim();
  }
  const levels = apiEffortLevels(profile?.id ?? "", model).filter(Boolean);
  if (!levels.length) return { model };
  const current = profile?.model === model ? profile.effort ?? "" : "";
  const options = ["", ...levels].map(value => ({
    label: value || "Авто (Codex / провайдер)", value, description: value === current ? "Текущее значение" : undefined,
  }));
  const selected = await vscode.window.showQuickPick(options, {
    title: "Глубина рассуждений (effort) по умолчанию · " + model, ignoreFocusOut: true,
  });
  if (!selected) return;
  return selected.value ? { model, effort: selected.value } : { model };
}

function inputKey(name: string, keepCurrent: boolean) {
  return vscode.window.showInputBox({ title: "API-ключ · " + name, password: true, ignoreFocusOut: true,
    prompt: keepCurrent ? "Оставьте пустым, чтобы сохранить действующий ключ." : "Введите ключ этого сервера. Для локального сервера без авторизации оставьте пустым." });
}

/** Native inputs keep provider credentials out of the webview and remote clients. */
export async function manageApiProviderSettings(store: ApiProviderProfileStore): Promise<void> {
  const profiles = await store.list();
  const pick = await vscode.window.showQuickPick([
    ...profiles.map(profile => ({ label: profile.name, description: [profile.model, profile.effort].filter(Boolean).join(" · "),
      detail: profile.baseUrl + (profile.hasApiKey ? " · ключ сохранён" : " · без ключа"), profile })),
    { label: "$(add) Добавить API-провайдера", profile: undefined },
  ], { title: "API-провайдеры", placeHolder: "Агент работает с файлами и доступами проекта в режиме разрешений Codex.", ignoreFocusOut: true });
  if (!pick) return;
  const profile = pick.profile;
  if (profile) {
    const actions = [
      profile.builtIn ? { label: profile.hasApiKey ? "Изменить API-ключ" : "Указать API-ключ", action: "key" }
        : { label: "Изменить название, адрес и ключ", action: "edit" },
      { label: "Модель и effort по умолчанию", action: "defaults" },
    ];
    if (profile.hasApiKey) actions.push({ label: "Удалить сохранённый ключ", action: "clear" });
    if (!profile.builtIn) actions.push({ label: "Удалить провайдера", action: "remove" });
    const choice = await vscode.window.showQuickPick(actions, { title: profile.name, ignoreFocusOut: true });
    if (!choice) return;
    if (choice.action === "defaults") {
      const defaults = await chooseDefaults(profile);
      if (!defaults) return;
      await store.save({ id: profile.id, ...defaults }, profile.baseUrl);
      void vscode.window.showInformationMessage("Настройки модели сохранены.");
      return;
    }
    if (choice.action === "key") {
      const apiKey = await inputKey(profile.name, profile.hasApiKey);
      if (!apiKey) return;
      await store.save({ id: profile.id, apiKey }, profile.baseUrl);
      void vscode.window.showInformationMessage("API-ключ сохранён.");
      return;
    }
    if (choice.action === "clear" || choice.action === "remove") {
      if (await vscode.window.showWarningMessage(choice.label + " — " + profile.name + "?", { modal: true }, "Удалить") !== "Удалить") return;
      if (choice.action === "clear") await store.clearApiKey(profile.id);
      else await store.remove(profile.id);
      return;
    }
  }
  const field = (title: string, value = "", placeHolder?: string) =>
    vscode.window.showInputBox({ title, value, placeHolder, ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : "Заполните поле." });
  const name = await field("Название API-провайдера", profile?.name);
  if (name === undefined) return;
  const baseUrl = await field("Базовый адрес Responses API", profile?.baseUrl, "https://example.com/v1");
  if (baseUrl === undefined) return;
  const settings = profile ? { id: profile.id } : await chooseDefaults();
  if (!settings) return;
  const apiKey = await inputKey(name, !!profile?.hasApiKey && baseUrl === profile.baseUrl);
  if (apiKey === undefined) return;
  await store.save({ ...settings, name, baseUrl, apiKey }, profile?.baseUrl);
  void vscode.window.showInformationMessage("API-провайдер сохранён.");
}
