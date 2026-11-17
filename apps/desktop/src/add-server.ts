interface DesktopBridge {
  addServer(input: string): Promise<{ ok: boolean; error?: string }>;
  brand(): Promise<{ name: string }>;
}

const bridge = (window as unknown as { desktop: DesktopBridge }).desktop;
const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('address') as HTMLInputElement;
const button = document.getElementById('submit') as HTMLButtonElement;
const error = document.getElementById('error') as HTMLElement;

void bridge.brand().then(({ name }) => {
  document.getElementById('title')!.textContent = `Add a ${name} server`;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  button.disabled = true;
  error.textContent = '';
  void bridge.addServer(input.value).then((result) => {
    button.disabled = false;
    if (!result.ok) error.textContent = result.error ?? 'Could not connect.';
  });
});
