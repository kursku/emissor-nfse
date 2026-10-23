[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory,

    [string] $Ref = 'HEAD'
)

$ErrorActionPreference = 'Stop'

# Exporta uma fotografia higienizada. A publicação no repositório público é
# manual e deve usar somente o conteúdo desta pasta.
$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    throw 'execute este procedimento dentro de um checkout git'
}

$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputPath) {
    throw "a pasta de saída já existe: $outputPath"
}

New-Item -ItemType Directory -Path $outputPath | Out-Null
$archivePath = Join-Path ([IO.Path]::GetTempPath()) `
    ("emissor-nfse-public-$([Guid]::NewGuid().ToString('N')).zip")

try {
    git -C $repoRoot archive --format=zip --output=$archivePath $Ref -- `
        . ':(exclude)HIGIENIZACAO.md'
    if ($LASTEXITCODE -ne 0) {
        throw "não foi possível criar a exportação de $Ref"
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $outputPath

    if (Test-Path -LiteralPath (Join-Path $outputPath 'HIGIENIZACAO.md')) {
        throw 'a exportação contém o checklist interno de higienização'
    }
} finally {
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
}

Write-Output "exportação pública criada em $outputPath"
