import { describe,expect,it } from 'vitest';
import { normalizeQuantity,recipeCost } from '../src/domain/pricing';
import type { Ingredient,Recipe } from '../src/domain/types';
const ingredients:Ingredient[]=[{id:'farinha',name:'Farinha',purchaseQuantity:1000,unit:'g',purchasePrice:6}];
const recipe:Recipe={id:'r',name:'Bolo',yield:10,items:[{ingredientId:'farinha',quantity:500}],packagingPerUnit:1,laborTotal:20,extraTotal:7,desiredMargin:20};
describe('Precificação',()=>{
 it('calcula custo total, unitário e margem sobre preço corretamente',()=>{const result=recipeCost(recipe,ingredients);expect(result.materials).toBe(3);expect(result.total).toBe(40);expect(result.costPerUnit).toBe(4);expect(result.suggestedPrice).toBe(5)});
 it('rejeita rendimento nulo',()=>expect(()=>recipeCost({...recipe,yield:0},ingredients)).toThrow());
 it('rejeita margem de 100%',()=>expect(()=>recipeCost({...recipe,desiredMargin:100},ingredients)).toThrow());
 it('não converte unidades incompatíveis',()=>expect(()=>normalizeQuantity(1,'kg','ml')).toThrow());
 it('converte quilogramas em gramas',()=>expect(normalizeQuantity(1,'kg','g')).toBe(1000));
});
