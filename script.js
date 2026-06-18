// VARIÁVEIS DO FIREBASE (Carrega os módulos oficiais direto da nuvem para o GitHub Pages)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, push, remove, set } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// Configuração oficial com o link do seu projeto Firebase
const firebaseConfig = {
    databaseURL: "https://internato-mafunda-default-rtdb.firebaseio.com/"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

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
    
    // 1. Atualiza o saldo localmente e envia o novo saldo definitivo para o Firebase
    saldo += trade.lucroAtual;
    set(dbRefSaldo, saldo); 

    // 2. Prepara os dados do histórico
    const tradeFechado = {
        ativo: trade.ativo,
        tipo: trade.tipo,
        lote: trade.lote,
        precoEntrada: trade.precoEntrada,
        precoSaida: precoAtualOuro,
        resultadoFinal: trade.lucroAtual >= 0 ? `+$${trade.lucroAtual.toFixed(2)}` : `-$${Math.abs(trade.lucroAtual).toFixed(2)}`,
        status: trade.lucroAtual >= 0 ? 'WIN' : 'LOSS',
        timestampFechar: new Date().toISOString()
    };

    // 3. Salva a operação de forma permanente na tabela de histórico ('operacoesFechadas') no Firebase
    push(dbRefFechadas, tradeFechado);

    // 4. Remove a operação da tabela de ativos ('operacoesAbertas') no Firebase
    if (trade.id_firebase) {
        const itemRef = ref(database, `operacoesAbertas/${trade.id_firebase}`);
        remove(itemRef);
    }
}

// ==========================================
// 🖥️ INTERFACE E INTERAÇÕES (UI)
// ==========================================

function renderizarTabelas() {
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

    if (operacoesFechadas.length === 0) {
        tabelaFechadas.innerHTML = `<tr><td colspan="5" style="color:#64748b; text-align:center;">Nenhum histórico disponível</td></tr>`;
    } else {
        // Exibe o histórico ordenado pelo mais recente primeiro
        const historicoOrdenado = [...operacoesFechadas].reverse();
        tabelaFechadas.innerHTML = historicoOrdenado.map(trade => `
            <tr>
                <td><b>${trade.ativo}</b></td>
                <td class="${trade.tipo.toLowerCase()}">${trade.tipo}</td>
                <td>${trade.lote.toFixed(2)}</td>
                <td style="color: ${trade.status === 'WIN' ? '#10b981' : '#ef4444'}; font-weight:bold;">${trade.resultadoFinal}</td>
                <td><span class="${trade.status === 'WIN' ? 'badge-win' : 'badge-loss'}">${trade.status}</span></td>
            </tr>
        `).join('');
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
