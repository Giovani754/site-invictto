// Invictto Motors - Supabase Client Init & Helpers
const SUPABASE_URL = "https://qmejocecjwcrovwztnqm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtZWpvY2Vjandjcm92d3p0bnFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5Nzk2MjgsImV4cCI6MjEwMzU1NTYyOH0.J-dumg1aNchCMueK_aSXSdG1UBr2pQllQ5tcerqX5Cs";

let supabaseClient = null;

if (window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  console.error("Supabase SDK JS não foi carregado corretamente.");
}

// Auth Guards, Logout & User Management
async function getAuthenticatedUser() {
  if (!supabaseClient) return null;
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error || !session) return null;
  return session.user;
}

async function requireAuth() {
  const user = await getAuthenticatedUser();
  if (!user) {
    window.location.href = "login.html";
  }
  return user;
}

async function redirectIfAuthenticated() {
  const user = await getAuthenticatedUser();
  if (user) {
    window.location.href = "dashboard.html";
  }
}

async function handleLogout() {
  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (err) {
      console.warn("Aviso ao encerrar sessão Supabase:", err);
    }
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch (e) {}
  window.location.href = "login.html";
}

async function updateUserCredentials({ email, password }) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const updates = {};
  if (email && email.trim() !== "") updates.email = email.trim();
  if (password && password.trim() !== "") updates.password = password.trim();

  if (Object.keys(updates).length === 0) {
    throw new Error("Nenhum dado informado para atualização.");
  }

  const { data, error } = await supabaseClient.auth.updateUser(updates);
  if (error) {
    throw error;
  }
  return data;
}

// Chama a Edge Function "gerenciar-usuarios" (valida sessão no servidor,
// diferente de auth.signUp que qualquer um pode chamar).
async function invocarGerenciarUsuarios(acao, email, senha) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");

  const { data, error } = await supabaseClient.functions.invoke("gerenciar-usuarios", {
    body: { acao, email: email.trim(), senha: senha.trim() }
  });

  if (error) {
    // FunctionsHttpError não traz a mensagem do corpo em error.message;
    // ela vem em error.context. Sem isso todo erro vira texto genérico.
    let detalhe = error.message;
    try {
      const corpo = await error.context.json();
      if (corpo && corpo.error) detalhe = corpo.error;
    } catch (e) {}
    throw new Error(detalhe);
  }

  if (data && data.error) throw new Error(data.error);
  return data;
}

async function createAdminUserForTeamMember(email, password) {
  if (!supabaseClient || !email || !password) return null;
  return await invocarGerenciarUsuarios("criar", email, password);
}

async function redefinirSenhaMembro(email, novaSenha) {
  if (!supabaseClient || !email || !novaSenha) return null;
  return await invocarGerenciarUsuarios("redefinir_senha", email, novaSenha);
}

// Vehicle Database & Storage Helpers
async function fetchVeiculos() {
  if (!supabaseClient) return [];
  const { data, error } = await supabaseClient
    .from('veiculos')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.warn("Erro ao buscar veículos no Supabase:", error.message);
    return null;
  }
  return data || [];
}

// Comprime a foto no navegador antes do upload (lado maior 1600px, JPEG 0.82).
// Nunca bloqueia o upload: em qualquer falha devolve o arquivo original.
async function comprimirImagem(file) {
  const LIMITE_BYTES = 400 * 1024;
  const LADO_MAXIMO = 1600;
  const QUALIDADE = 0.82;

  if (file.size < LIMITE_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
    const largura = Math.round(bitmap.width * escala);
    const altura = Math.round(bitmap.height * escala);

    const canvas = document.createElement('canvas');
    canvas.width = largura;
    canvas.height = altura;
    const ctx = canvas.getContext('2d');
    // JPEG não tem transparência: sem fundo branco, PNG com alfa ficaria preto.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, largura, altura);
    ctx.drawImage(bitmap, 0, 0, largura, altura);
    bitmap.close();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALIDADE));
    if (!blob) throw new Error('canvas.toBlob não gerou imagem.');
    if (blob.size >= file.size) return file;

    const nome = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], nome, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (err) {
    console.warn('Compressão da imagem falhou, enviando o original:', err);
    return file;
  }
}

async function uploadFotoVeiculo(originalFile) {
  if (!supabaseClient || !originalFile) return null;

  const file = await comprimirImagem(originalFile);
  const fileExt = file.name.split('.').pop();
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;
  const filePath = `estoque/${fileName}`;

  try {
    const { data, error } = await supabaseClient.storage
      .from('veiculos-fotos')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true
      });

    if (error) {
      console.warn("Upload no bucket veiculos-fotos falhou, usando fallback:", error.message);
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
    }

    const { data: publicUrlData } = supabaseClient.storage
      .from('veiculos-fotos')
      .getPublicUrl(filePath);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error("Erro no upload de foto:", err);
    return null;
  }
}

async function uploadMultipleFotosVeiculo(files) {
  if (!files || files.length === 0) return [];
  const urls = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const url = await uploadFotoVeiculo(file);
    if (url) urls.push(url);
  }
  return urls;
}

async function createVeiculo(veiculo) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const { data, error } = await supabaseClient
    .from('veiculos')
    .insert([veiculo])
    .select();

  if (error) {
    throw error;
  }
  return data;
}

async function updateVeiculo(id, updates) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const { data, error } = await supabaseClient
    .from('veiculos')
    .update(updates)
    .eq('id', id)
    .select();

  if (error) {
    throw error;
  }
  return data;
}

async function updateVeiculoStatus(id, newStatus) {
  return await updateVeiculo(id, { status: newStatus });
}

async function deleteVeiculoById(id) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const { data, error } = await supabaseClient
    .from('veiculos')
    .delete()
    .eq('id', id);

  if (error) {
    throw error;
  }
  return data;
}

// Team (Equipe) Database Helpers
async function fetchEquipe() {
  if (!supabaseClient) return [];
  const { data, error } = await supabaseClient
    .from('equipe')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.warn("Erro ao buscar membros da equipe no Supabase:", error.message);
    return null;
  }
  return data || [];
}

async function createEquipeMembro(membro) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const { data, error } = await supabaseClient
    .from('equipe')
    .insert([membro])
    .select();

  if (error) {
    throw error;
  }
  return data;
}

async function updateEquipeMembro(id, updates) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const { data, error } = await supabaseClient
    .from('equipe')
    .update(updates)
    .eq('id', id)
    .select();

  if (error) {
    throw error;
  }
  return data;
}

async function deleteEquipeMembroById(id) {
  if (!supabaseClient) throw new Error("Supabase não inicializado.");
  
  const { data, error } = await supabaseClient
    .from('equipe')
    .delete()
    .eq('id', id);

  if (error) {
    throw error;
  }
  return data;
}
