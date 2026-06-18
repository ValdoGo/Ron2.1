// VARIÁVEIS DO FIREBASE (Carrega os módulos oficiais direto da nuvem para o GitHub Pages)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, push, remove, set } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// Configuração oficial com o link do seu projeto Firebase
const firebaseConfig = {
    databaseURL: "https://internato-mafunda-default-rtdb.firebaseio.com/"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
let meuGrafico = null; // Guardará a instância do Chart.js

// Referências das tabelas na nuvem
const dbRefAbertas = ref(database, 'operacoesAbertas');
const dbRefFechadas = ref(database, 'operacoesFechadas');
const dbRefSaldo = ref(database, 'saldoSistema');

// Variáveis Globais do Sistema (Valores iniciais de segurança caso o Firebase esteja vazio)
let saldo = 100.00;
let equity = 100.00;
let precoAtualOuro = 0;

let operacoesAbertas = []; 
let operacoesFechadas = [];

// Elementos da Interface
const txtSaldo = document.getElementById('txt-saldo');
const txtEquity = document.getElementById('txt-equity');
const precoXauElemento = document.getElementById('preco-xau');
const tabelaAbertas = document.getElementById('tabela-abertas');
const tabelaFechadas = document.getElementById('tabela-fechadas');

// Elementos do Modal de Ordem/Login
const modal = document.getElementById('modal-container');
const btnAbrirModal = document.getElementById('btn-abrir-modal');
const btnFecharModal = document.getElementById('btn-fechar-modal');
const etapaLogin = document.getElementById('etapa-login');
const etapaOrdem = document.getElementById('etapa-ordem');

// ==========================================
// 🔄 SINCRONIZAÇÃO EM TEMPO REAL COM O FIREBASE (ANTI-CRASH)
// ==========================================

// 1. ESCUTADOR DO SALDO: Recupera o último saldo salvo na nuvem
onValue(dbRefSaldo, (snapshot) => {
    const saldoSalvo = snapshot.val();
    if (saldoSalvo !== null) {
        saldo = parseFloat(saldoSalvo);
    } else {
        // Se for a primeira vez rodando e não tiver saldo no Firebase, cria o inicial de $100
        set(dbRefSaldo, saldo);
    }
    txtSaldo.innerText = `$${saldo.toFixed(2)}`;
});

// 2. ESCUTADOR DAS ORDENS ABERTAS
onValue(dbRefAbertas, (snapshot) => {
    const dados = snapshot.val();
    if (dados) {
        operacoesAbertas = Object.keys(dados).map(key => {
            const ordem = dados[key];
            const precoDeEntradaFixado = ordem.precoEntrada ? parseFloat(ordem.precoEntrada) : 0;

            return {
                id_firebase: key,
                ...ordem,
                precoEntrada: precoDeEntradaFixado,
                lucroAtual: 0
            };
        });
    } else {
        operacoesAbertas = [];
    }
    renderizarTabelas();
});

// 3. ESCUTADOR DO HISTÓRICO (ORDENS FECHADAS): Garante que o histórico resiste a reinicializações
onValue(dbRefFechadas, (snapshot) => {
    const dados = snapshot.val();
    if (dados) {
        operacoesFechadas = Object.keys(dados).map(key => ({
            id_firebase: key,
            ...dados[key]
        }));
    } else {
        operacoesFechadas = [];
    }
    renderizarTabelas();
});


// ==========================================
// 📈 CONEXÃO DERIV & LÓGICA DE TRADING
// ==========================================

function conectarPrecoOuro() {
    const app_id = 1089;
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);
    let ultimoPreco = 0;

    ws.onopen = () => {
        ws.send(JSON.stringify({ ticks: "frxXAUUSD" }));
    };

    ws.onmessage = (evento) => {
        const dados = JSON.parse(evento.data);
        
        if (dados.msg_type === 'tick' && dados.tick) {
            precoAtualOuro = parseFloat(dados.tick.quote);
            precoXauElemento.innerText = `$${precoAtualOuro.toFixed(2)}`;

            if (precoAtualOuro > ultimoPreco) {
                precoXauElemento.style.color = '#10b981';
            } else if (precoAtualOuro < ultimoPreco) {
                precoXauElemento.style.color = '#f43f5e';
            }
            ultimoPreco = precoAtualOuro;

            processarTradesDisparados();
        }
    };

    ws.onerror = (erro) => {
        console.error('Erro no WebSocket da Deriv:', erro);
        precoXauElemento.innerText = "Erro na Deriv";
    };

    ws.onclose = () => {
        setTimeout(conectarPrecoOuro, 5000);
    };
}

function processarTradesDisparados() {
    let lucroFlutuanteTotal = 0;
    let indicesParaFechar = [];

    operacoesAbertas.forEach((trade, index) => {
        if (!trade || trade.precoEntrada === 0) return;

        let diferencaPreco = 0;
        
        if (trade.tipo === 'BUY') {
            diferencaPreco = precoAtualOuro - trade.precoEntrada;
            
            if (typeof trade.sl === 'number' && !isNaN(trade.sl) && trade.sl > 0) {
                if (precoAtualOuro <= trade.sl) indicesParaFechar.push(index);
            }
            if (typeof trade.tp === 'number' && !isNaN(trade.tp) && trade.tp > 0) {
                if (precoAtualOuro >= trade.tp) indicesParaFechar.push(index);
            }
        } else { // SELL
            diferencaPreco = trade.precoEntrada - precoAtualOuro;
            
            if (typeof trade.sl === 'number' && !isNaN(trade.sl) && trade.sl > 0) {
                if (precoAtualOuro >= trade.sl) indicesParaFechar.push(index);
            }
            if (typeof trade.tp === 'number' && !isNaN(trade.tp) && trade.tp > 0) {
                if (precoAtualOuro <= trade.tp) indicesParaFechar.push(index);
            }
        }

        trade.lucroAtual = diferencaPreco * trade.lote * 100; 
        lucroFlutuanteTotal += trade.lucroAtual;
    });

    equity = saldo + lucroFlutuanteTotal;
    txtEquity.innerText = `$${equity.toFixed(2)}`;

    if (indicesParaFechar.length > 0) {
        let indicesUnicos = [...new Set(indicesParaFechar)].sort((a, b) => b - a);
        for (let i = 0; i < indicesUnicos.length; i++) {
            fecharOperacao(indicesUnicos[i]);
        }
    }

    renderizarTabelas();
}

function fecharOperacao(index) {
    let trade = operacoesAbertas[index];
    if (!trade) return;
    
    // 1. Calcula e atualiza o novo saldo localmente
    saldo += trade.lucroAtual;
    
    // 2. Formata a data e hora atual de forma legível (DD/MM/AAAA HH:MM:SS)
    const agora = new Date();
    const dataFormatada = agora.toLocaleDateString('pt-PT') + ' ' + agora.toLocaleTimeString('pt-PT');

    // 3. Prepara os dados do histórico contendo a data e o saldo resultante exato pós-fecho
    const tradeFechado = {
        ativo: trade.ativo,
        tipo: trade.tipo,
        lote: trade.lote,
        precoEntrada: trade.precoEntrada,
        precoSaida: precoAtualOuro,
        resultadoFinal: trade.lucroAtual >= 0 ? `+$${trade.lucroAtual.toFixed(2)}` : `-$${Math.abs(trade.lucroAtual).toFixed(2)}`,
        status: trade.lucroAtual >= 0 ? 'WIN' : 'LOSS',
        dataFecho: dataFormatada,
        saldoAposFecho: saldo // Guarda o saldo exato após a operação
    };

    // 4. Envia o novo saldo definitivo para o Firebase
    set(dbRefSaldo, saldo); 

    // 5. Salva a operação de forma permanente na tabela de histórico no Firebase
    push(dbRefFechadas, tradeFechado);

    // 6. Remove a operação da tabela de ativos no Firebase
    if (trade.id_firebase) {
        const itemRef = ref(database, `operacoesAbertas/${trade.id_firebase}`);
        remove(itemRef);
    }
}

// ==========================================
// 🖥️ INTERFACE E INTERAÇÕES (UI)
// ==========================================

// ==========================================
// 🖥️ INTERFACE E INTERAÇÕES (UI)
// ==========================================

function renderizarTabelas() {
    // 1. RENDERIZAÇÃO DA TABELA DE OPERAÇÕES ABERTAS
    if (operacoesAbertas.length === 0) {
        tabelaAbertas.innerHTML = `<tr><td colspan="6" style="color:#64748b; text-align:center;">Nenhuma operação aberta</td></tr>`;
    } else {
        tabelaAbertas.innerHTML = operacoesAbertas.map(trade => `
            <tr>
                <td><b>${trade.ativo}</b></td>
                <td class="${trade.tipo.toLowerCase()}">${trade.tipo}</td>
                <td>${trade.lote.toFixed(2)}</td>
                <td>$${trade.precoEntrada.toFixed(2)}</td>
                <td class="col-sl-tp"><small>SL: ${trade.sl || '-'}<br/>TP: ${trade.tp || '-'}</small></td>
                <td style="color: ${trade.lucroAtual >= 0 ? '#10b981' : '#ef4444'}; font-weight:bold;">
                    ${trade.lucroAtual >= 0 ? '+' : ''}$${trade.lucroAtual.toFixed(2)}
                </td>
            </tr>
        `).join('');
    }

    // 2. RENDERIZAÇÃO DA TABELA DE HISTÓRICO (OPERAÇÕES FECHADAS)
    if (operacoesFechadas.length === 0) {
        tabelaFechadas.innerHTML = `<tr><td colspan="6" style="color:#64748b; text-align:center;">Nenhum histórico disponível</td></tr>`;
        atualizarAnalytics([]); // Envia vazio se não houver histórico
    } else {
        // Exibe o histórico ordenado pelo mais recente primeiro para a tabela
        const historicoOrdenado = [...operacoesFechadas].reverse();
        tabelaFechadas.innerHTML = historicoOrdenado.map(trade => `
            <tr>
                <td><b>${trade.ativo}</b><br/><small style="color:#64748b;">${trade.dataFecho || '-'}</small></td>
                <td class="${trade.tipo ? trade.tipo.toLowerCase() : ''}">${trade.tipo || '-'}</td>
                <td>${trade.lote ? trade.lote.toFixed(2) : '0.00'}</td>
                <td style="color: ${trade.status === 'WIN' ? '#10b981' : '#ef4444'}; font-weight:bold;">${trade.resultadoFinal || '$0.00'}</td>
                <td><span class="${trade.status === 'WIN' ? 'badge-win' : 'badge-loss'}">${trade.status || 'LOSS'}</span></td>
                <td><b>$${trade.saldoAposFecho ? trade.saldoAposFecho.toFixed(2) : '0.00'}</b></td>
            </tr>
        `).join('');

        // Atualiza os Analytics usando o histórico na ordem cronológica correta (antigo para o novo)
        atualizarAnalytics(operacoesFechadas);
    }
}

// 3. FUNÇÃO AUXILIAR PARA PROCESSAR GRÁFICO E CARTÕES
function atualizarAnalytics(dadosHistorico) {
    const totalTrades = dadosHistorico.length;
    
    if (totalTrades === 0) {
        document.getElementById('stat-total').innerText = "0";
        document.getElementById('stat-winrate').innerText = "0%";
        document.getElementById('stat-lucro').innerText = "$0.00";
        return;
    }

    let wins = 0;
    let lucroTotal = 0;
    let pontosSaldo = [100.00]; // Ponto de partida inicial padrão (ou ajuste conforme seu depósito inicial)
    let labelsEixoX = ["Início"];

    // Processa os dados cronologicamente
    dadosHistorico.forEach((trade, index) => {
        if (trade.status === 'WIN') wins++;
        
        // Limpa a string de resultado de "+$10.50" para float 10.50
        if (trade.resultadoFinal) {
            const valorLimpo = parseFloat(trade.resultadoFinal.replace('$', '').replace('+', ''));
            lucroTotal += valorLimpo;
        }

        // Guarda o saldo resultante para desenhar no gráfico
        if (trade.saldoAposFecho) {
            pontosSaldo.push(trade.saldoAposFecho);
        } else {
            pontosSaldo.push(100.00 + lucroTotal); // Fallback de segurança
        }
        
        // Extrai apenas a hora ou data curta para não sobrecarregar o gráfico
        const dataCurta = trade.dataFecho ? trade.dataFecho.split(' ')[0] : `#${index + 1}`;
        labelsEixoX.push(dataCurta);
    });

    const winRate = ((wins / totalTrades) * 100).toFixed(1);

    // Atualiza os elementos de texto na tela
    document.getElementById('stat-total').innerText = totalTrades;
    document.getElementById('stat-winrate').innerText = `${winRate}%`;
    
    const txtLucro = document.getElementById('stat-lucro');
    txtLucro.innerText = `${lucroTotal >= 0 ? '+' : ''}$${lucroTotal.toFixed(2)}`;
    txtLucro.style.color = lucroTotal >= 0 ? '#10b981' : '#ef4444';

    // RENDERIZAÇÃO OU ATUALIZAÇÃO DO GRÁFICO CHART.JS
    const ctx = document.getElementById('graficoSaldo').getContext('2d');
    
    if (meuGrafico) {
        // Se o gráfico já existe, apenas atualiza os dados para evitar flickering
        meuGrafico.data.labels = labelsEixoX;
        meuGrafico.data.datasets[0].data = pontosSaldo;
        meuGrafico.update();
    } else {
        // Cria a primeira instância do gráfico
        meuGrafico = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labelsEixoX,
                datasets: [{
                    label: 'Curva de Capital ($)',
                    data: pontosSaldo,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2,
                    tension: 0.2, // Linha levemente curva
                    fill: true,
                    pointBackgroundColor: '#3b82f6',
                    pointRadius: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false } // Oculta a legenda redundante
                },
                scales: {
                    x: {
                        grid: { color: '#1e293b' },
                        ticks: { color: '#64748b', maxTicksLimit: 8 }
                    },
                    y: {
                        grid: { color: '#1e293b' },
                        ticks: { color: '#64748b' }
                    }
                }
            }
        });
    }
}

btnAbrirModal.onclick = () => {
    modal.style.display = 'flex';
    etapaLogin.style.display = 'block';
    etapaOrdem.style.display = 'none';
    document.getElementById('ipt-user').focus();
};

btnFecharModal.onclick = () => {
    modal.style.display = 'none';
};

document.getElementById('btn-login').onclick = efetuarLogin;
function efetuarLogin() {
    const user = document.getElementById('ipt-user').value;
    const pass = document.getElementById('ipt-pass').value;

    if (user === 'Admin' && pass === '2003') {
        document.getElementById('erro-login').style.display = 'none';
        etapaLogin.style.display = 'none';
        etapaOrdem.style.display = 'block';
        document.getElementById('ipt-lote').focus();
    } else {
        document.getElementById('erro-login').style.display = 'block';
    }
}

document.getElementById('btn-enviar-ordem').onclick = criarNovaOrdem;
function criarNovaOrdem() {
    if (precoAtualOuro === 0) {
        alert("Aguarde a cotação do Ouro carregar para abrir uma ordem.");
        return;
    }

    const tipoOrdem = document.getElementById('slc-tipo').value;
    const lote = parseFloat(document.getElementById('ipt-lote').value);
    const slInput = document.getElementById('ipt-sl').value;
    const tpInput = document.getElementById('ipt-tp').value;

    const slValor = slInput ? parseFloat(slInput) : null;
    const tpValor = tpInput ? parseFloat(tpInput) : null;

    if (tipoOrdem === 'BUY') {
        if (slValor !== null && slValor >= precoAtualOuro) {
            alert(`Erro no Stop Loss!\nPara COMPRAS (BUY), o SL deve ser MENOR que o preço atual ($${precoAtualOuro.toFixed(2)}).`);
            return;
        }
        if (tpValor !== null && tpValor <= precoAtualOuro) {
            alert(`Erro no Take Profit!\nPara COMPRAS (BUY), o TP deve ser MAIOR que o preço atual ($${precoAtualOuro.toFixed(2)}).`);
            return;
        }
    } else if (tipoOrdem === 'SELL') {
        if (slValor !== null && slValor <= precoAtualOuro) {
            alert(`Erro no Stop Loss!\nPara VENDAS (SELL), o SL deve ser MAIOR que o preço atual ($${precoAtualOuro.toFixed(2)}).`);
            return;
        }
        if (tpValor !== null && tpValor >= precoAtualOuro) {
            alert(`Erro no Take Profit!\nPara VENDAS (SELL), o TP deve ser MENOR que o preço atual ($${precoAtualOuro.toFixed(2)}).`);
            return;
        }
    }

    const novaOrdem = {
        ativo: document.getElementById('slc-ativo').value,
        tipo: tipoOrdem,
        lote: lote,
        precoEntrada: precoAtualOuro, 
        sl: slValor,
        tp: tpValor
    };

    push(dbRefAbertas, novaOrdem);
    
    modal.style.display = 'none';
    document.getElementById('ipt-user').value = '';
    document.getElementById('ipt-pass').value = '';
    document.getElementById('ipt-sl').value = '';
    document.getElementById('ipt-tp').value = '';
}

modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (etapaLogin.style.display !== 'none') efetuarLogin();
        else if (etapaOrdem.style.display !== 'none') criarNovaOrdem();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    conectarPrecoOuro();
});
