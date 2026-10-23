export function comandosInstalacao(dependenciasInstaladas) {
  return dependenciasInstaladas
    ? ['npm run patch:apply']
    : ['npm ci', 'npm run patch:apply'];
}
